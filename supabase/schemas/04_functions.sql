-- Database functions (RPCs and RLS helpers).
--
-- search_path is pinned to public on every SECURITY DEFINER function to avoid
-- search-path hijacking. SQL helpers used inside RLS policies are declared
-- first because the diff tool validates SQL function bodies at creation time.
--
-- NOTE: the `on_auth_user_created` trigger that calls handle_new_user() and the
-- `on_auth_user_deleted` trigger that calls _tombstone_deleted_auth_user() live
-- on auth.users and are NOT declared here (the functions are). `supabase db diff`
-- only tracks the public schema, so those triggers (and the supabase_realtime
-- publication) are kept in versioned migrations instead. See schemas/README.md.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.email),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

-- Membership check runs as SECURITY DEFINER to bypass RLS on group_members.
-- A SELECT policy on group_members that queries group_members would otherwise
-- trigger "infinite recursion detected in policy".
create or replace function public.is_group_member(p_group_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_user_id
  );
$$;

-- Mirrors is_group_member for contact-expense participation.
create or replace function public.is_contact_participant(
  p_expense_id uuid,
  p_user_id uuid
)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.contact_expenses ce
    where ce.id = p_expense_id
      and (ce.user_lo = p_user_id or ce.user_hi = p_user_id)
  );
$$;

-- Scopes the profiles SELECT policy. A profile is visible to the caller only
-- when the two of them actually share something: a group, an accepted contact
-- pair, a contact request, or a one-on-one expense/payment. Without this the
-- policy was `using (true)`, i.e. every signed-in user could read the whole
-- user directory.
create or replace function public.can_view_profile(p_profile_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select
    p_profile_id = auth.uid()
    or exists (
      select 1
      from public.group_members mine
      join public.group_members theirs on theirs.group_id = mine.group_id
      where mine.user_id = auth.uid() and theirs.user_id = p_profile_id
    )
    or exists (
      select 1 from public.contacts c
      where (c.owner_id = auth.uid() and c.contact_user_id = p_profile_id)
         or (c.owner_id = p_profile_id and c.contact_user_id = auth.uid())
    )
    or exists (
      select 1 from public.contact_requests cr
      where (cr.requester_id = auth.uid() and cr.recipient_id = p_profile_id)
         or (cr.requester_id = p_profile_id and cr.recipient_id = auth.uid())
    )
    or exists (
      select 1 from public.contact_expenses ce
      where (ce.user_lo = auth.uid() and ce.user_hi = p_profile_id)
         or (ce.user_lo = p_profile_id and ce.user_hi = auth.uid())
    )
    or exists (
      select 1 from public.contact_payments cp
      where (cp.user_lo = auth.uid() and cp.user_hi = p_profile_id)
         or (cp.user_lo = p_profile_id and cp.user_hi = auth.uid())
    );
$$;

-- Recent group-expense activity for the caller's own feed.
--
-- "Involved" means the caller paid for the expense or holds a non-zero split in
-- it. That predicate has to run before the row cap: applying a limit first and
-- filtering on the client pushed the caller's own items out of the feed in busy
-- groups. Nested payer/group/split data is returned as jsonb so the shape
-- matches what the client already renders. schedule_id, occurrence_date and
-- hand_edited (the last three columns) say which recurring schedule made the
-- expense, for which calendar date, and whether someone edited it by hand (a
-- moved occurrence keeps its occurrence_date while its date changes). The first
-- two are null for an expense no schedule made; hand_edited is false for it.
create or replace function public.get_recent_activity(p_limit int default 50)
returns table (
  id uuid,
  description text,
  amount numeric,
  currency text,
  date timestamptz,
  paid_by uuid,
  group_id uuid,
  payer jsonb,
  groups jsonb,
  expense_splits jsonb,
  schedule_id uuid,
  occurrence_date date,
  hand_edited boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return query
  select
    e.id,
    e.description,
    e.amount,
    e.currency,
    e.date,
    e.paid_by,
    e.group_id,
    to_jsonb(pr.*) as payer,
    jsonb_build_object('name', g.name) as groups,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('user_id', es.user_id, 'amount', es.amount)
        )
        from public.expense_splits es
        where es.expense_id = e.id
      ),
      '[]'::jsonb
    ) as expense_splits,
    e.schedule_id,
    e.occurrence_date,
    e.hand_edited
  from public.expenses e
  join public.groups g on g.id = e.group_id
  join public.profiles pr on pr.id = e.paid_by
  where public.is_group_member(e.group_id, v_uid)
    and e.date <= now()
    and (
      e.paid_by = v_uid
      or exists (
        select 1 from public.expense_splits es
        where es.expense_id = e.id
          and es.user_id = v_uid
          and es.amount > 0
      )
    )
  order by e.date desc
  limit greatest(coalesce(p_limit, 50), 1);
end;
$$;

-- The caller's future-dated group expenses (date after now()), soonest first.
-- Same columns and "involved" rule as get_recent_activity, which leaves these
-- rows out so they cannot crowd its row cap.
create or replace function public.get_upcoming_expenses(p_limit int default 50)
returns table (
  id uuid,
  description text,
  amount numeric,
  currency text,
  date timestamptz,
  paid_by uuid,
  group_id uuid,
  payer jsonb,
  groups jsonb,
  expense_splits jsonb,
  schedule_id uuid,
  occurrence_date date,
  hand_edited boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return query
  select
    e.id,
    e.description,
    e.amount,
    e.currency,
    e.date,
    e.paid_by,
    e.group_id,
    to_jsonb(pr.*) as payer,
    jsonb_build_object('name', g.name) as groups,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('user_id', es.user_id, 'amount', es.amount)
        )
        from public.expense_splits es
        where es.expense_id = e.id
      ),
      '[]'::jsonb
    ) as expense_splits,
    e.schedule_id,
    e.occurrence_date,
    e.hand_edited
  from public.expenses e
  join public.groups g on g.id = e.group_id
  join public.profiles pr on pr.id = e.paid_by
  where public.is_group_member(e.group_id, v_uid)
    and e.date > now()
    and (
      e.paid_by = v_uid
      or exists (
        select 1 from public.expense_splits es
        where es.expense_id = e.id
          and es.user_id = v_uid
          and es.amount > 0
      )
    )
  order by e.date asc
  limit greatest(coalesce(p_limit, 50), 1);
end;
$$;

create or replace function public.get_group_balances(p_group_id uuid)
returns table (
  user_id uuid,
  full_name text,
  balance numeric(12, 2)
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_member(p_group_id, auth.uid()) then
    raise exception 'You are not a member of this group';
  end if;

  -- Sum base_amount (each row converted to the group's base currency at entry
  -- time) so cross-currency expenses net out correctly within the group. A row
  -- dated in the future counts from its date.
  return query
  select
    gm.user_id,
    p.full_name,
    coalesce(paid.total_paid, 0)
      - coalesce(owed.total_owed, 0)
      + coalesce(sent.total_sent, 0)
      - coalesce(received.total_received, 0)
    as balance
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  left join (
    select e.paid_by as uid, sum(e.base_amount) as total_paid
    from public.expenses e
    where e.group_id = p_group_id and e.date <= now() group by e.paid_by
  ) paid on paid.uid = gm.user_id
  left join (
    select es.user_id as uid, sum(es.base_amount) as total_owed
    from public.expense_splits es
    join public.expenses e on e.id = es.expense_id
    where e.group_id = p_group_id and e.date <= now() group by es.user_id
  ) owed on owed.uid = gm.user_id
  left join (
    select py.paid_to as uid, sum(py.base_amount) as total_received
    from public.payments py
    where py.group_id = p_group_id and py.date <= now() group by py.paid_to
  ) received on received.uid = gm.user_id
  left join (
    select py.paid_by as uid, sum(py.base_amount) as total_sent
    from public.payments py
    where py.group_id = p_group_id and py.date <= now() group by py.paid_by
  ) sent on sent.uid = gm.user_id
  where gm.group_id = p_group_id;
end;
$$;

-- Which of the given emails have an account.
--
-- Returns the emails only, never user ids. The client needs the "no account
-- for x@y.com" message when inviting someone, but handing back a stable uuid
-- per address turned this into an email -> user-id directory that any signed-in
-- account could harvest. Batches are capped to blunt bulk enumeration.
create or replace function public.check_emails_registered(p_emails text[])
returns table (email text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  if coalesce(array_length(p_emails, 1), 0) > 20 then
    raise exception 'Too many emails requested';
  end if;

  return query
  select lower(au.email)::text
  from auth.users au
  join public.profiles p on p.id = au.id
  where lower(au.email) in (
    select lower(btrim(e)) from unnest(coalesce(p_emails, '{}'::text[])) as e
  );
end;
$$;

-- Whether an email can be invited to a group the caller belongs to: 'ok',
-- 'not_registered', or 'already_member'. Lets the add-members screen validate
-- an address inline without the client ever seeing the other user's id, and
-- only answers for groups the caller is actually in.
create or replace function public.check_group_member_email(
  p_group_id uuid,
  p_email text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  if v_email = '' then
    raise exception 'Enter an email address';
  end if;

  select p.id into v_id
  from auth.users au
  join public.profiles p on p.id = au.id
  where lower(au.email) = v_email;

  if v_id is null then
    return 'not_registered';
  end if;

  if public.is_group_member(p_group_id, v_id) then
    return 'already_member';
  end if;

  return 'ok';
end;
$$;

-- Leave a group atomically, reassigning ownership or deleting the group when
-- the last member leaves. Done in SECURITY DEFINER to sidestep the
-- "creator can update" policy that would block transferring created_by.
create or replace function public.leave_group(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_other_count int;
  v_created_by uuid;
  v_new_owner uuid;
  v_balance numeric(12, 2);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = v_uid
  ) then
    raise exception 'You are not a member of this group';
  end if;

  -- Only live members count: a deleted account (profiles.deleted_at) can stay in
  -- a group as a ghost, but nobody sees the group through it, and it cannot be
  -- handed the group.
  select count(*) into v_other_count
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id and gm.user_id <> v_uid and p.deleted_at is null;

  if v_other_count = 0 then
    delete from public.groups where id = p_group_id;
    return;
  end if;

  -- While other members remain, an outstanding balance must be settled first.
  -- Enforced here as well as in the UI: the client guard reads a balance query
  -- that may not have resolved yet, and leaving with debts drops the caller's
  -- splits out of get_group_balances, silently moving everyone else's numbers.
  select balance into v_balance
  from public.get_group_balances(p_group_id)
  where user_id = v_uid;

  if abs(coalesce(v_balance, 0)) >= 0.01 then
    raise exception 'Settle your outstanding balance before leaving this group';
  end if;

  -- Future-dated rows are not in the balance above yet but will be on their
  -- date, so the caller cannot leave while one involves them. "Involves" is
  -- get_upcoming_expenses' rule, so whatever blocks is listed there to cancel.
  -- The same goes for a schedule that is still running (not stopped or
  -- completed): it will create occurrences, so it blocks its payer and every user
  -- in its splits (compared as uuids). Its creator is audit only and may leave.
  -- Any member may stop a schedule.
  if exists (
    select 1 from public.expenses e
    where e.group_id = p_group_id
      and e.date > now()
      and (
        e.paid_by = v_uid
        or exists (
          select 1 from public.expense_splits es
          where es.expense_id = e.id
            and es.user_id = v_uid
            and es.amount > 0
        )
      )
  ) or exists (
    select 1 from public.payments py
    where py.group_id = p_group_id
      and py.date > now()
      and v_uid in (py.paid_by, py.paid_to)
  ) or exists (
    select 1 from public.recurring_schedules s
    where s.group_id = p_group_id
      and s.stopped_at is null
      and (
        s.paid_by = v_uid
        or exists (
          select 1 from jsonb_array_elements(s.splits) sp
          where (sp->>'userId')::uuid = v_uid
        )
      )
  ) then
    raise exception 'You have upcoming or repeating transactions in this group. Cancel or stop them before leaving.';
  end if;

  select created_by into v_created_by from public.groups where id = p_group_id;

  if v_created_by = v_uid then
    select gm.user_id into v_new_owner
    from public.group_members gm
    join public.profiles p on p.id = gm.user_id
    where gm.group_id = p_group_id and gm.user_id <> v_uid and p.deleted_at is null
    order by gm.joined_at asc
    limit 1;

    update public.groups set created_by = v_new_owner where id = p_group_id;
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = v_uid;
end;
$$;

-- Internal: one user's net balance in one group, the same arithmetic as
-- get_group_balances (base amounts, rows dated in the future not yet counted)
-- but for p_user_id rather than for whoever is signed in, so account deletion can
-- ask it with no JWT. Not callable by clients.
create or replace function public._group_member_balance(p_group_id uuid, p_user_id uuid)
returns numeric
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select (
    coalesce((
      select sum(e.base_amount) from public.expenses e
      where e.group_id = p_group_id and e.paid_by = p_user_id and e.date <= now()
    ), 0)
    - coalesce((
      select sum(es.base_amount)
      from public.expense_splits es
      join public.expenses e on e.id = es.expense_id
      where e.group_id = p_group_id and es.user_id = p_user_id and e.date <= now()
    ), 0)
    + coalesce((
      select sum(py.base_amount) from public.payments py
      where py.group_id = p_group_id and py.paid_by = p_user_id and py.date <= now()
    ), 0)
    - coalesce((
      select sum(py.base_amount) from public.payments py
      where py.group_id = p_group_id and py.paid_to = p_user_id and py.date <= now()
    ), 0)
  )::numeric(12, 2);
$$;

revoke execute on function public._group_member_balance(uuid, uuid)
  from public, anon, authenticated;

-- Internal: takes p_uid out of one group for an account deletion. Not a gate and
-- raises nothing for the business cases; not callable by clients. delete_my_account
-- must first stop the user's running schedules and delete their future-dated
-- expenses and payments, and only then call this for every group they are in:
-- this function does neither, and a schedule or future row still there keeps the
-- membership as a ghost.
--   1. Not a member: nothing happens.
--   2. No other live member (another member whose profile has no deleted_at):
--      the group is deleted with everything in it; nobody alive can see it.
--   3. Otherwise a group p_uid created goes to the longest-standing other live
--      member (joined_at, then user_id).
--   4. The membership is removed only when p_uid's net balance is zero and nothing
--      future-dated or still running involves them (leave_group's rules), and, in a
--      group with simplify_debts off, no pairwise edge involving them is open.
--      Otherwise it stays as a ghost: balances join group_members, so dropping a
--      member with a non-zero balance would silently move everyone else's numbers.
--      The pairwise rule (added after #27): with simplify off the raw "who owes whom"
--      edges are shown, a member can net to zero and still owe one person and be owed
--      by another, and create_payment refuses a payment with a non-member, so those
--      edges could never be settled. With simplify on only net balances are shown and
--      a net-zero member has no edge.
-- It does not use auth.uid().
create or replace function public._account_leave_group(p_uid uuid, p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_created_by uuid;
  v_new_owner uuid;
begin
  if p_uid is null or p_group_id is null or not exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = p_uid
  ) then
    return;
  end if;

  select created_by into v_created_by
  from public.groups where id = p_group_id for update;

  select gm.user_id into v_new_owner
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  where gm.group_id = p_group_id and gm.user_id <> p_uid and p.deleted_at is null
  order by gm.joined_at asc, gm.user_id asc
  limit 1;

  if v_new_owner is null then
    delete from public.groups where id = p_group_id;
    return;
  end if;

  if v_created_by = p_uid then
    update public.groups set created_by = v_new_owner where id = p_group_id;
  end if;

  if abs(public._group_member_balance(p_group_id, p_uid)) >= 0.01 then
    return;
  end if;

  if exists (select 1 from public.groups g where g.id = p_group_id and not g.simplify_debts)
    and exists (
      select 1 from public._group_pairwise_balances(p_group_id) e
      where p_uid in (e.from_user, e.to_user)
    ) then
    return;
  end if;

  if exists (
    select 1 from public.expenses e
    where e.group_id = p_group_id
      and e.date > now()
      and (
        e.paid_by = p_uid
        or exists (
          select 1 from public.expense_splits es
          where es.expense_id = e.id
            and es.user_id = p_uid
            and es.amount > 0
        )
      )
  ) or exists (
    select 1 from public.payments py
    where py.group_id = p_group_id
      and py.date > now()
      and p_uid in (py.paid_by, py.paid_to)
  ) or exists (
    select 1 from public.recurring_schedules s
    where s.group_id = p_group_id
      and s.stopped_at is null
      and (
        s.paid_by = p_uid
        or exists (
          select 1 from jsonb_array_elements(s.splits) sp
          where (sp->>'userId')::uuid = p_uid
        )
      )
  ) then
    return;
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = p_uid;
end;
$$;

revoke execute on function public._account_leave_group(uuid, uuid)
  from public, anon, authenticated;

-- Normalises a list of invite emails: lowercased, trimmed, blanks dropped,
-- deduped, and with the caller's own address removed (they are always a member
-- of a group they create or invite to). Shared by the group invite RPCs.
create or replace function public.normalize_invite_emails(p_emails text[])
returns text[]
language sql
security definer
stable
set search_path = public
as $$
  select coalesce(array_agg(distinct lower(btrim(raw))), '{}'::text[])
  from unnest(coalesce(p_emails, '{}'::text[])) as raw
  where btrim(raw) <> ''
    and lower(btrim(raw)) is distinct from (
      select lower(au.email) from auth.users au where au.id = auth.uid()
    );
$$;

-- Creates a group and seeds its membership.
--
-- Takes member *emails*, not ids: resolving them here means the client never
-- has to ask for (and never receives) a user id for an arbitrary address, and
-- the "who has an account" check happens in the same transaction as the insert
-- instead of racing it.
create or replace function public.create_group_with_members(
  p_name text,
  p_member_emails text[] default '{}',
  p_currency text default 'USD'
)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups;
  v_emails text[];
  v_missing text[];
  v_member_id uuid;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'Group name is required';
  end if;

  v_emails := public.normalize_invite_emails(p_member_emails);

  if coalesce(array_length(v_emails, 1), 0) > 20 then
    raise exception 'Too many emails requested';
  end if;

  select coalesce(array_agg(e), '{}'::text[])
  into v_missing
  from unnest(v_emails) as e
  where not exists (
    select 1
    from auth.users au
    join public.profiles p on p.id = au.id
    where lower(au.email) = e
  );

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception 'No account found for: %',
      array_to_string(v_missing, ', ');
  end if;

  insert into public.groups (name, created_by, currency)
  values (btrim(p_name), v_uid, v_currency)
  returning * into v_group;

  insert into public.group_members (group_id, user_id)
  values (v_group.id, v_uid);

  for v_member_id in
    select p.id
    from auth.users au
    join public.profiles p on p.id = au.id
    where lower(au.email) = any(v_emails)
  loop
    if v_member_id <> v_uid then
      insert into public.group_members (group_id, user_id)
      values (v_group.id, v_member_id)
      on conflict (group_id, user_id) do nothing;
    end if;
  end loop;

  return v_group;
end;
$$;

-- Adds members to an existing group by email. Any existing member may invite
-- others. Emails without an account, and people already in the group, are
-- reported by address so the caller gets a usable error.
create or replace function public.add_group_members(
  p_group_id uuid,
  p_member_emails text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_emails text[];
  v_missing text[];
  v_existing text[];
  v_member_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  v_emails := public.normalize_invite_emails(p_member_emails);

  if coalesce(array_length(v_emails, 1), 0) = 0 then
    raise exception 'Add at least one other person''s email';
  end if;

  if array_length(v_emails, 1) > 20 then
    raise exception 'Too many emails requested';
  end if;

  select coalesce(array_agg(e), '{}'::text[])
  into v_missing
  from unnest(v_emails) as e
  where not exists (
    select 1
    from auth.users au
    join public.profiles p on p.id = au.id
    where lower(au.email) = e
  );

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception 'No account found for: %',
      array_to_string(v_missing, ', ');
  end if;

  select coalesce(array_agg(e), '{}'::text[])
  into v_existing
  from unnest(v_emails) as e
  where exists (
    select 1
    from auth.users au
    join public.group_members gm on gm.user_id = au.id
    where lower(au.email) = e and gm.group_id = p_group_id
  );

  if coalesce(array_length(v_existing, 1), 0) > 0 then
    raise exception 'Already in this group: %',
      array_to_string(v_existing, ', ');
  end if;

  for v_member_id in
    select p.id
    from auth.users au
    join public.profiles p on p.id = au.id
    where lower(au.email) = any(v_emails)
  loop
    insert into public.group_members (group_id, user_id)
    values (p_group_id, v_member_id);
  end loop;
end;
$$;

-- Renames a group. Any member may rename (routed through this SECURITY DEFINER
-- RPC, so the creator-only UPDATE policy on groups is left untouched).
create or replace function public.rename_group(p_group_id uuid, p_name text)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'Group name is required';
  end if;

  update public.groups
  set name = btrim(p_name)
  where id = p_group_id
  returning * into v_group;

  return v_group;
end;
$$;

-- Internal: the body of create_expense_with_splits, run on behalf of p_actor
-- instead of auth.uid() so the recurring engine (no JWT) can reuse it. Not
-- callable by clients; p_schedule_id / p_occurrence_date link the row to a
-- recurring schedule.
create or replace function public._insert_group_expense(
  p_actor uuid,
  p_group_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_date timestamptz default null,
  p_currency text default 'USD',
  p_exchange_rate numeric default 1,
  p_schedule_id uuid default null,
  p_occurrence_date date default null
)
returns public.expenses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_expense public.expenses;
  v_split jsonb;
  v_split_user uuid;
  v_split_amount numeric(12, 2);
  v_split_base numeric(12, 2);
  v_split_total numeric(12, 2) := 0;
  v_split_base_total numeric(12, 2) := 0;
  v_split_count int := 0;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
  v_rate numeric := coalesce(p_exchange_rate, 1);
  v_base_amount numeric(12, 2);
begin
  if not public.is_group_member(p_group_id, p_actor) then
    raise exception 'You are not a member of this group';
  end if;

  if not public.is_group_member(p_group_id, p_paid_by) then
    raise exception 'Expense payer must be a group member';
  end if;

  if p_amount <= 0
    or p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Expense amount must be greater than zero';
  end if;

  if v_rate <= 0
    or v_rate in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Exchange rate must be greater than zero';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Expense description is required';
  end if;

  v_base_amount := round(p_amount * v_rate, 2);

  for v_split in select value from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb))
  loop
    v_split_user := (v_split->>'userId')::uuid;
    if (v_split->>'amount')::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      or (v_split->>'baseAmount')::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'Split amount must be a valid number';
    end if;
    v_split_amount := round((v_split->>'amount')::numeric, 2);
    v_split_base := round(
      coalesce((v_split->>'baseAmount')::numeric, (v_split->>'amount')::numeric * v_rate), 2
    );

    if v_split_amount < 0 then
      raise exception 'Split amount cannot be negative';
    end if;

    if not public.is_group_member(p_group_id, v_split_user) then
      raise exception 'Every split user must be a group member';
    end if;

    v_split_count := v_split_count + 1;
    v_split_total := v_split_total + v_split_amount;
    v_split_base_total := v_split_base_total + v_split_base;
  end loop;

  if exists (
    select 1 from public.profiles p
    where p.deleted_at is not null
      and (p.id = p_paid_by or p.id in (select (s->>'userId')::uuid from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb)) s))
  ) then
    raise exception 'Deleted users cannot be added to new expenses';
  end if;

  if v_split_count = 0 then
    raise exception 'At least one split is required';
  end if;

  if v_split_total <> round(p_amount, 2) then
    raise exception 'Split amounts must add up to the expense total';
  end if;

  if v_split_base_total <> v_base_amount then
    raise exception 'Split base amounts must add up to the converted total';
  end if;

  insert into public.expenses (
    group_id,
    paid_by,
    amount,
    description,
    category,
    split_type,
    date,
    currency,
    exchange_rate,
    base_amount,
    schedule_id,
    occurrence_date
  )
  values (
    p_group_id,
    p_paid_by,
    round(p_amount, 2),
    btrim(p_description),
    p_category,
    p_split_type,
    coalesce(p_date, now()),
    v_currency,
    v_rate,
    v_base_amount,
    p_schedule_id,
    p_occurrence_date
  )
  returning * into v_expense;

  for v_split in select value from jsonb_array_elements(p_splits)
  loop
    insert into public.expense_splits (expense_id, user_id, amount, base_amount)
    values (
      v_expense.id,
      (v_split->>'userId')::uuid,
      round((v_split->>'amount')::numeric, 2),
      round(
        coalesce((v_split->>'baseAmount')::numeric, (v_split->>'amount')::numeric * v_rate), 2
      )
    );
  end loop;

  return v_expense;
end;
$$;

revoke execute on function public._insert_group_expense(uuid, uuid, uuid, numeric, text, text, public.split_type, jsonb, timestamptz, text, numeric, uuid, date)
  from public, anon, authenticated;

create or replace function public.create_expense_with_splits(
  p_group_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_date timestamptz default null,
  p_currency text default 'USD',
  p_exchange_rate numeric default 1
)
returns public.expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return public._insert_group_expense(
    v_uid,
    p_group_id,
    p_paid_by,
    p_amount,
    p_description,
    p_category,
    p_split_type,
    p_splits,
    p_date,
    p_currency,
    p_exchange_rate
  );
end;
$$;

-- Internal: the body of update_expense_with_splits, run on behalf of p_actor
-- instead of auth.uid() so the recurring update (no JWT) can reuse it. Not
-- callable by clients. p_mark_hand_edited flags a schedule-linked row as
-- edited by hand; the recurring update passes false so rewriting a series
-- does not freeze it, and an existing mark is never cleared.
create or replace function public._update_group_expense(
  p_actor uuid,
  p_expense_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_date timestamptz default null,
  p_currency text default 'USD',
  p_exchange_rate numeric default 1,
  p_mark_hand_edited boolean default true
)
returns public.expenses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group_id uuid;
  v_expense public.expenses;
  v_split jsonb;
  v_split_user uuid;
  v_split_amount numeric(12, 2);
  v_split_base numeric(12, 2);
  v_split_total numeric(12, 2) := 0;
  v_split_base_total numeric(12, 2) := 0;
  v_split_count int := 0;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
  v_rate numeric := coalesce(p_exchange_rate, 1);
  v_base_amount numeric(12, 2);
begin
  select group_id into v_group_id from public.expenses where id = p_expense_id;

  if v_group_id is null then
    raise exception 'Expense not found';
  end if;

  if not public.is_group_member(v_group_id, p_actor) then
    raise exception 'You are not a member of this group';
  end if;

  if not public.is_group_member(v_group_id, p_paid_by) then
    raise exception 'Expense payer must be a group member';
  end if;

  if p_amount <= 0
    or p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Expense amount must be greater than zero';
  end if;

  if v_rate <= 0
    or v_rate in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Exchange rate must be greater than zero';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Expense description is required';
  end if;

  v_base_amount := round(p_amount * v_rate, 2);

  for v_split in select value from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb))
  loop
    v_split_user := (v_split->>'userId')::uuid;
    if (v_split->>'amount')::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      or (v_split->>'baseAmount')::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'Split amount must be a valid number';
    end if;
    v_split_amount := round((v_split->>'amount')::numeric, 2);
    v_split_base := round(
      coalesce((v_split->>'baseAmount')::numeric, (v_split->>'amount')::numeric * v_rate), 2
    );

    if v_split_amount < 0 then
      raise exception 'Split amount cannot be negative';
    end if;

    if not public.is_group_member(v_group_id, v_split_user) then
      raise exception 'Every split user must be a group member';
    end if;

    v_split_count := v_split_count + 1;
    v_split_total := v_split_total + v_split_amount;
    v_split_base_total := v_split_base_total + v_split_base;
  end loop;

  -- A deleted user may stay on an expense they were already part of, in the same
  -- role, but cannot be added to it.
  if (
    p_paid_by is distinct from (select e.paid_by from public.expenses e where e.id = p_expense_id)
    and exists (select 1 from public.profiles p where p.id = p_paid_by and p.deleted_at is not null)
  ) or exists (
    select 1 from public.profiles p
    where p.deleted_at is not null
      and p.id in (select (s->>'userId')::uuid from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb)) s)
      and not exists (
        select 1 from public.expense_splits es where es.expense_id = p_expense_id and es.user_id = p.id
      )
  ) then
    raise exception 'Deleted users cannot be added to new expenses';
  end if;

  if v_split_count = 0 then
    raise exception 'At least one split is required';
  end if;

  if v_split_total <> round(p_amount, 2) then
    raise exception 'Split amounts must add up to the expense total';
  end if;

  if v_split_base_total <> v_base_amount then
    raise exception 'Split base amounts must add up to the converted total';
  end if;

  update public.expenses
  set
    paid_by = p_paid_by,
    amount = round(p_amount, 2),
    description = btrim(p_description),
    category = p_category,
    split_type = p_split_type,
    date = coalesce(p_date, date),
    currency = v_currency,
    exchange_rate = v_rate,
    base_amount = v_base_amount,
    hand_edited = case
      when p_mark_hand_edited and schedule_id is not null then true
      else hand_edited
    end
  where id = p_expense_id
  returning * into v_expense;

  delete from public.expense_splits where expense_id = p_expense_id;

  for v_split in select value from jsonb_array_elements(p_splits)
  loop
    insert into public.expense_splits (expense_id, user_id, amount, base_amount)
    values (
      p_expense_id,
      (v_split->>'userId')::uuid,
      round((v_split->>'amount')::numeric, 2),
      round(
        coalesce((v_split->>'baseAmount')::numeric, (v_split->>'amount')::numeric * v_rate), 2
      )
    );
  end loop;

  return v_expense;
end;
$$;

revoke execute on function public._update_group_expense(uuid, uuid, uuid, numeric, text, text, public.split_type, jsonb, timestamptz, text, numeric, boolean)
  from public, anon, authenticated;

-- Edits an existing group expense and replaces its splits atomically. Any group
-- member may edit (mirrors the relaxed delete policy); the SECURITY DEFINER
-- context bypasses the payer-only UPDATE RLS. Validations match create. A row
-- that belongs to a recurring schedule is marked hand_edited.
create or replace function public.update_expense_with_splits(
  p_expense_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_date timestamptz default null,
  p_currency text default 'USD',
  p_exchange_rate numeric default 1
)
returns public.expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return public._update_group_expense(
    v_uid,
    p_expense_id,
    p_paid_by,
    p_amount,
    p_description,
    p_category,
    p_split_type,
    p_splits,
    p_date,
    p_currency,
    p_exchange_rate,
    true
  );
end;
$$;

-- Inserts the bidirectional accepted-contact pair. Helper shared by request
-- acceptance and the mutual-send auto-accept path.
create or replace function public.create_contact_pair(p_user_a uuid, p_user_b uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.contacts (owner_id, contact_user_id)
  values (p_user_a, p_user_b)
  on conflict (owner_id, contact_user_id) do nothing;

  insert into public.contacts (owner_id, contact_user_id)
  values (p_user_b, p_user_a)
  on conflict (owner_id, contact_user_id) do nothing;
end;
$$;

-- Sends a contact request by email. If the recipient already sent the caller a
-- pending request, the two are auto-accepted (mutual intent). A prior
-- declined/stale request for the same pair is reset to pending.
--
-- Takes an email rather than a user id so the client never needs to resolve an
-- arbitrary address to a uuid first.
create or replace function public.send_contact_request(p_recipient_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_recipient uuid;
  v_reverse public.contact_requests;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if v_email = '' then
    raise exception 'Enter an email address';
  end if;

  select p.id into v_recipient
  from auth.users au
  join public.profiles p on p.id = au.id
  where lower(au.email) = v_email;

  if v_recipient is null then
    raise exception 'No account found for %', v_email;
  end if;

  if v_recipient = v_uid then
    raise exception 'You cannot add yourself as a contact';
  end if;

  if exists (
    select 1 from public.contacts
    where owner_id = v_uid and contact_user_id = v_recipient
  ) then
    raise exception 'This person is already a contact';
  end if;

  -- Mutual intent: if they already requested me, accept it instead.
  select * into v_reverse
  from public.contact_requests
  where requester_id = v_recipient
    and recipient_id = v_uid
    and status = 'pending';

  if found then
    update public.contact_requests
    set status = 'accepted', responded_at = now()
    where id = v_reverse.id;
    perform public.create_contact_pair(v_uid, v_recipient);
    return;
  end if;

  insert into public.contact_requests (requester_id, recipient_id, status)
  values (v_uid, v_recipient, 'pending')
  on conflict (requester_id, recipient_id)
  do update set status = 'pending', created_at = now(), responded_at = null;
end;
$$;

-- Recipient accepts or declines a pending request. Accepting creates the
-- bidirectional contact pair.
create or replace function public.respond_contact_request(
  p_request_id uuid,
  p_accept boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_request public.contact_requests;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_request
  from public.contact_requests
  where id = p_request_id;

  if not found then
    raise exception 'Request not found';
  end if;

  if v_request.recipient_id <> v_uid then
    raise exception 'You can only respond to requests sent to you';
  end if;

  if v_request.status <> 'pending' then
    raise exception 'This request has already been handled';
  end if;

  if p_accept then
    update public.contact_requests
    set status = 'accepted', responded_at = now()
    where id = p_request_id;
    perform public.create_contact_pair(v_request.requester_id, v_request.recipient_id);
  else
    update public.contact_requests
    set status = 'declined', responded_at = now()
    where id = p_request_id;
  end if;
end;
$$;

-- Requester withdraws a pending request they sent.
create or replace function public.cancel_contact_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_request public.contact_requests;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_request
  from public.contact_requests
  where id = p_request_id;

  if not found then
    raise exception 'Request not found';
  end if;

  if v_request.requester_id <> v_uid then
    raise exception 'You can only cancel requests you sent';
  end if;

  delete from public.contact_requests where id = p_request_id;
end;
$$;

-- Pending requests involving the caller, with the other person's profile and a
-- direction marker ('incoming' = sent to me, 'outgoing' = sent by me).
create or replace function public.get_contact_requests()
returns table (
  id uuid,
  direction text,
  status text,
  created_at timestamptz,
  user_id uuid,
  full_name text,
  avatar_url text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return query
  select
    cr.id,
    case when cr.recipient_id = v_uid then 'incoming' else 'outgoing' end as direction,
    cr.status,
    cr.created_at,
    p.id as user_id,
    p.full_name,
    p.avatar_url
  from public.contact_requests cr
  join public.profiles p
    on p.id = case when cr.recipient_id = v_uid then cr.requester_id else cr.recipient_id end
  where cr.status = 'pending'
    and (cr.requester_id = v_uid or cr.recipient_id = v_uid)
  order by cr.created_at desc;
end;
$$;

-- Internal: the body of create_contact_expense_with_splits, run on behalf of p_actor
-- instead of auth.uid() so the recurring engine (no JWT) can reuse it. Not
-- callable by clients; p_schedule_id / p_occurrence_date link the row to a
-- recurring schedule.
create or replace function public._insert_contact_expense(
  p_actor uuid,
  p_contact_user_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_date timestamptz default null,
  p_currency text default 'USD',
  p_exchange_rate numeric default 1,
  p_schedule_id uuid default null,
  p_occurrence_date date default null
)
returns public.contact_expenses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lo uuid;
  v_hi uuid;
  v_expense public.contact_expenses;
  v_split jsonb;
  v_split_user uuid;
  v_split_amount numeric(12, 2);
  v_split_base numeric(12, 2);
  v_split_total numeric(12, 2) := 0;
  v_split_base_total numeric(12, 2) := 0;
  v_split_count int := 0;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
  v_rate numeric := coalesce(p_exchange_rate, 1);
  v_base_amount numeric(12, 2);
begin
  if p_contact_user_id is null or p_contact_user_id = p_actor then
    raise exception 'Invalid contact';
  end if;

  if not exists (
    select 1 from public.contacts
    where owner_id = p_actor and contact_user_id = p_contact_user_id
  ) then
    raise exception 'You can only add expenses with accepted contacts';
  end if;

  if p_paid_by <> p_actor and p_paid_by <> p_contact_user_id then
    raise exception 'Expense payer must be you or the contact';
  end if;

  if p_amount <= 0
    or p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Expense amount must be greater than zero';
  end if;

  if v_rate <= 0
    or v_rate in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Exchange rate must be greater than zero';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Expense description is required';
  end if;

  if p_actor < p_contact_user_id then
    v_lo := p_actor;
    v_hi := p_contact_user_id;
  else
    v_lo := p_contact_user_id;
    v_hi := p_actor;
  end if;

  v_base_amount := round(p_amount * v_rate, 2);

  for v_split in select value from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb))
  loop
    v_split_user := (v_split->>'userId')::uuid;
    if (v_split->>'amount')::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      or (v_split->>'baseAmount')::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'Split amount must be a valid number';
    end if;
    v_split_amount := round((v_split->>'amount')::numeric, 2);
    v_split_base := round(
      coalesce((v_split->>'baseAmount')::numeric, (v_split->>'amount')::numeric * v_rate), 2
    );

    if v_split_amount < 0 then
      raise exception 'Split amount cannot be negative';
    end if;

    if v_split_user <> v_lo and v_split_user <> v_hi then
      raise exception 'Every split user must be a participant';
    end if;

    v_split_count := v_split_count + 1;
    v_split_total := v_split_total + v_split_amount;
    v_split_base_total := v_split_base_total + v_split_base;
  end loop;

  if exists (
    select 1 from public.profiles p
    where p.deleted_at is not null
      and (p.id = p_contact_user_id or p.id = p_paid_by or p.id in (select (s->>'userId')::uuid from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb)) s))
  ) then
    raise exception 'Deleted users cannot be added to new expenses';
  end if;

  if v_split_count = 0 then
    raise exception 'At least one split is required';
  end if;

  if v_split_total <> round(p_amount, 2) then
    raise exception 'Split amounts must add up to the expense total';
  end if;

  if v_split_base_total <> v_base_amount then
    raise exception 'Split base amounts must add up to the converted total';
  end if;

  insert into public.contact_expenses (
    paid_by,
    user_lo,
    user_hi,
    amount,
    description,
    category,
    split_type,
    date,
    currency,
    exchange_rate,
    base_amount,
    schedule_id,
    occurrence_date
  )
  values (
    p_paid_by,
    v_lo,
    v_hi,
    round(p_amount, 2),
    btrim(p_description),
    p_category,
    p_split_type,
    coalesce(p_date, now()),
    v_currency,
    v_rate,
    v_base_amount,
    p_schedule_id,
    p_occurrence_date
  )
  returning * into v_expense;

  for v_split in select value from jsonb_array_elements(p_splits)
  loop
    insert into public.contact_expense_splits (expense_id, user_id, amount, base_amount)
    values (
      v_expense.id,
      (v_split->>'userId')::uuid,
      round((v_split->>'amount')::numeric, 2),
      round(
        coalesce((v_split->>'baseAmount')::numeric, (v_split->>'amount')::numeric * v_rate), 2
      )
    );
  end loop;

  return v_expense;
end;
$$;

revoke execute on function public._insert_contact_expense(uuid, uuid, uuid, numeric, text, text, public.split_type, jsonb, timestamptz, text, numeric, uuid, date)
  from public, anon, authenticated;

create or replace function public.create_contact_expense_with_splits(
  p_contact_user_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_date timestamptz default null,
  p_currency text default 'USD',
  p_exchange_rate numeric default 1
)
returns public.contact_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return public._insert_contact_expense(
    v_uid,
    p_contact_user_id,
    p_paid_by,
    p_amount,
    p_description,
    p_category,
    p_split_type,
    p_splits,
    p_date,
    p_currency,
    p_exchange_rate
  );
end;
$$;

-- Internal: the body of update_contact_expense_with_splits, run on behalf of
-- p_actor instead of auth.uid() so the recurring update (no JWT) can reuse it.
-- Not callable by clients. p_mark_hand_edited flags a schedule-linked row as
-- edited by hand; the recurring update passes false so rewriting a series
-- does not freeze it, and an existing mark is never cleared.
create or replace function public._update_contact_expense(
  p_actor uuid,
  p_expense_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_date timestamptz default null,
  p_currency text default 'USD',
  p_exchange_rate numeric default 1,
  p_mark_hand_edited boolean default true
)
returns public.contact_expenses
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lo uuid;
  v_hi uuid;
  v_expense public.contact_expenses;
  v_split jsonb;
  v_split_user uuid;
  v_split_amount numeric(12, 2);
  v_split_base numeric(12, 2);
  v_split_total numeric(12, 2) := 0;
  v_split_base_total numeric(12, 2) := 0;
  v_split_count int := 0;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
  v_rate numeric := coalesce(p_exchange_rate, 1);
  v_base_amount numeric(12, 2);
begin
  select user_lo, user_hi into v_lo, v_hi
  from public.contact_expenses where id = p_expense_id;

  if v_lo is null then
    raise exception 'Expense not found';
  end if;

  if p_actor is distinct from v_lo and p_actor is distinct from v_hi then
    raise exception 'You are not a participant in this expense';
  end if;

  if p_paid_by <> v_lo and p_paid_by <> v_hi then
    raise exception 'Expense payer must be a participant';
  end if;

  if p_amount <= 0
    or p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Expense amount must be greater than zero';
  end if;

  if v_rate <= 0
    or v_rate in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Exchange rate must be greater than zero';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Expense description is required';
  end if;

  v_base_amount := round(p_amount * v_rate, 2);

  for v_split in select value from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb))
  loop
    v_split_user := (v_split->>'userId')::uuid;
    if (v_split->>'amount')::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      or (v_split->>'baseAmount')::numeric in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'Split amount must be a valid number';
    end if;
    v_split_amount := round((v_split->>'amount')::numeric, 2);
    v_split_base := round(
      coalesce((v_split->>'baseAmount')::numeric, (v_split->>'amount')::numeric * v_rate), 2
    );

    if v_split_amount < 0 then
      raise exception 'Split amount cannot be negative';
    end if;

    if v_split_user <> v_lo and v_split_user <> v_hi then
      raise exception 'Every split user must be a participant';
    end if;

    v_split_count := v_split_count + 1;
    v_split_total := v_split_total + v_split_amount;
    v_split_base_total := v_split_base_total + v_split_base;
  end loop;

  -- A deleted user may stay on an expense they were already part of, in the same
  -- role, but cannot be added to it.
  if (
    p_paid_by is distinct from (select e.paid_by from public.contact_expenses e where e.id = p_expense_id)
    and exists (select 1 from public.profiles p where p.id = p_paid_by and p.deleted_at is not null)
  ) or exists (
    select 1 from public.profiles p
    where p.deleted_at is not null
      and p.id in (select (s->>'userId')::uuid from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb)) s)
      and not exists (
        select 1 from public.contact_expense_splits es where es.expense_id = p_expense_id and es.user_id = p.id
      )
  ) then
    raise exception 'Deleted users cannot be added to new expenses';
  end if;

  if v_split_count = 0 then
    raise exception 'At least one split is required';
  end if;

  if v_split_total <> round(p_amount, 2) then
    raise exception 'Split amounts must add up to the expense total';
  end if;

  if v_split_base_total <> v_base_amount then
    raise exception 'Split base amounts must add up to the converted total';
  end if;

  update public.contact_expenses
  set
    paid_by = p_paid_by,
    amount = round(p_amount, 2),
    description = btrim(p_description),
    category = p_category,
    split_type = p_split_type,
    date = coalesce(p_date, date),
    currency = v_currency,
    exchange_rate = v_rate,
    base_amount = v_base_amount,
    hand_edited = case
      when p_mark_hand_edited and schedule_id is not null then true
      else hand_edited
    end
  where id = p_expense_id
  returning * into v_expense;

  delete from public.contact_expense_splits where expense_id = p_expense_id;

  for v_split in select value from jsonb_array_elements(p_splits)
  loop
    insert into public.contact_expense_splits (expense_id, user_id, amount, base_amount)
    values (
      p_expense_id,
      (v_split->>'userId')::uuid,
      round((v_split->>'amount')::numeric, 2),
      round(
        coalesce((v_split->>'baseAmount')::numeric, (v_split->>'amount')::numeric * v_rate), 2
      )
    );
  end loop;

  return v_expense;
end;
$$;

revoke execute on function public._update_contact_expense(uuid, uuid, uuid, numeric, text, text, public.split_type, jsonb, timestamptz, text, numeric, boolean)
  from public, anon, authenticated;

-- Edits an existing one-on-one contact expense and replaces its splits. Either
-- participant may edit (SECURITY DEFINER bypasses the payer-only UPDATE RLS).
-- The participant pair (user_lo/user_hi) is immutable; only payer/amount/
-- description/category/split/date and the splits change. A row that belongs to
-- a recurring schedule is marked hand_edited.
create or replace function public.update_contact_expense_with_splits(
  p_expense_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_date timestamptz default null,
  p_currency text default 'USD',
  p_exchange_rate numeric default 1
)
returns public.contact_expenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return public._update_contact_expense(
    v_uid,
    p_expense_id,
    p_paid_by,
    p_amount,
    p_description,
    p_category,
    p_split_type,
    p_splits,
    p_date,
    p_currency,
    p_exchange_rate,
    true
  );
end;
$$;

create or replace function public.get_contact_balance(p_contact_user_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_lo uuid;
  v_hi uuid;
  v_expense_balance numeric(12, 2);
  v_payment_balance numeric(12, 2);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_contact_user_id is null or p_contact_user_id = v_uid then
    return 0;
  end if;

  if v_uid < p_contact_user_id then
    v_lo := v_uid;
    v_hi := p_contact_user_id;
  else
    v_lo := p_contact_user_id;
    v_hi := v_uid;
  end if;

  select coalesce(sum(
    case
      when ce.paid_by = v_uid and ces.user_id = p_contact_user_id then ces.base_amount
      when ce.paid_by = p_contact_user_id and ces.user_id = v_uid then -ces.base_amount
      else 0
    end
  ), 0)
  into v_expense_balance
  from public.contact_expenses ce
  join public.contact_expense_splits ces on ces.expense_id = ce.id
  where ce.user_lo = v_lo and ce.user_hi = v_hi and ce.date <= now();

  -- A 1-on-1 payment you make to the contact settles your debt (raises the
  -- balance); a payment they make to you lowers it. Same sign rules as the
  -- shared-group payment term in get_contact_group_balance.
  select coalesce(sum(
    case
      when cp.paid_by = v_uid and cp.paid_to = p_contact_user_id then cp.base_amount
      when cp.paid_by = p_contact_user_id and cp.paid_to = v_uid then -cp.base_amount
      else 0
    end
  ), 0)
  into v_payment_balance
  from public.contact_payments cp
  where cp.user_lo = v_lo and cp.user_hi = v_hi and cp.date <= now();

  return coalesce(v_expense_balance, 0) + coalesce(v_payment_balance, 0);
end;
$$;

create or replace function public.get_contacts_with_balances()
returns table (
  contact_user_id uuid,
  full_name text,
  avatar_url text,
  balance numeric(12, 2)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return query
  with contact_ids as (
    select c.contact_user_id as uid
    from public.contacts c
    where c.owner_id = v_uid
    union
    select case when ce.user_lo = v_uid then ce.user_hi else ce.user_lo end as uid
    from public.contact_expenses ce
    where ce.user_lo = v_uid or ce.user_hi = v_uid
    union
    select case when cp.user_lo = v_uid then cp.user_hi else cp.user_lo end as uid
    from public.contact_payments cp
    where cp.user_lo = v_uid or cp.user_hi = v_uid
  )
  select
    ci.uid,
    p.full_name,
    p.avatar_url,
    public.get_contact_balance(ci.uid) as balance
  from contact_ids ci
  join public.profiles p on p.id = ci.uid
  where ci.uid <> v_uid
  order by p.full_name;
end;
$$;

-- The base currency for a one-on-one contact ledger (defaults to 'USD' when the
-- pair has no explicit setting).
create or replace function public.get_contact_currency(p_contact_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_lo uuid;
  v_hi uuid;
  v_currency text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_contact_user_id is null or p_contact_user_id = v_uid then
    return 'USD';
  end if;

  if v_uid < p_contact_user_id then
    v_lo := v_uid;
    v_hi := p_contact_user_id;
  else
    v_lo := p_contact_user_id;
    v_hi := v_uid;
  end if;

  select currency into v_currency
  from public.contact_pair_settings
  where user_lo = v_lo and user_hi = v_hi;

  return coalesce(v_currency, 'USD');
end;
$$;

-- Per-context pieces of a contact's combined balance: the 1-on-1 ledger (in the
-- pair's base currency) plus one row per shared group (in that group's base
-- currency). Returned un-summed so the client can convert each piece into the
-- viewer's display currency before adding them up (they may be different
-- currencies). Display only; get_user_total_balance must NOT fold the group
-- rows in (they are already summed via get_group_balances).
create or replace function public.get_contact_balance_contexts(p_contact_user_id uuid)
returns table (
  currency text,
  balance numeric(12, 2)
)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 1-on-1 ledger piece, in the contact pair's base currency.
  return query
  select
    public.get_contact_currency(p_contact_user_id) as currency,
    public.get_contact_balance(p_contact_user_id)::numeric(12, 2) as balance;

  -- Shared-group pieces, each in its own group's base currency.
  return query
  select b.currency, b.balance
  from public.get_contact_group_breakdown(p_contact_user_id) b;
end;
$$;

-- Sets (upserts) the base currency for a one-on-one contact ledger. Either
-- participant may set it; routed through SECURITY DEFINER so the table needs no
-- direct write policy.
create or replace function public.set_contact_currency(
  p_contact_user_id uuid,
  p_currency text
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_lo uuid;
  v_hi uuid;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
  v_existing_currency text;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_contact_user_id is null or p_contact_user_id = v_uid then
    raise exception 'Invalid contact';
  end if;

  if not exists (
    select 1 from public.contacts
    where owner_id = v_uid and contact_user_id = p_contact_user_id
  ) then
    raise exception 'You can only set the currency for accepted contacts';
  end if;

  if v_uid < p_contact_user_id then
    v_lo := v_uid;
    v_hi := p_contact_user_id;
  else
    v_lo := p_contact_user_id;
    v_hi := v_uid;
  end if;

  select currency into v_existing_currency
  from public.contact_pair_settings
  where user_lo = v_lo and user_hi = v_hi;

  -- A running schedule creates its expenses in the pair's base currency, so the
  -- currency cannot change under it even before it has produced any activity.
  if coalesce(v_existing_currency, 'USD') <> v_currency and exists (
    select 1 from public.recurring_schedules s
    where s.user_lo = v_lo and s.user_hi = v_hi and s.stopped_at is null
  ) then
    raise exception 'Cannot change contact currency while a repeating expense is active. Stop it first.';
  end if;

  if exists (
    select 1 from public.contact_expenses ce
    where ce.user_lo = v_lo and ce.user_hi = v_hi
  ) or exists (
    select 1 from public.contact_payments cp
    where cp.user_lo = v_lo and cp.user_hi = v_hi
  ) then
    if coalesce(v_existing_currency, 'USD') <> v_currency then
      raise exception 'Cannot change contact currency after activity exists';
    end if;
    return v_currency;
  end if;

  insert into public.contact_pair_settings (user_lo, user_hi, currency, updated_at)
  values (v_lo, v_hi, v_currency, now())
  on conflict (user_lo, user_hi)
  do update set currency = excluded.currency, updated_at = now();

  return v_currency;
end;
$$;

-- Sets a group's base currency. Any member may change it (mirrors rename_group).
create or replace function public.set_group_currency(
  p_group_id uuid,
  p_currency text
)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  select * into v_group
  from public.groups
  where id = p_group_id;

  -- A running schedule creates its expenses in the group's base currency, so the
  -- currency cannot change under it even before it has produced any activity.
  if v_group.currency <> v_currency and exists (
    select 1 from public.recurring_schedules s
    where s.group_id = p_group_id and s.stopped_at is null
  ) then
    raise exception 'Cannot change group currency while a repeating expense is active. Stop it first.';
  end if;

  if exists (select 1 from public.expenses e where e.group_id = p_group_id)
    or exists (select 1 from public.payments p where p.group_id = p_group_id)
  then
    if v_group.currency <> v_currency then
      raise exception 'Cannot change group currency after activity exists';
    end if;
    return v_group;
  end if;

  update public.groups
  set currency = v_currency
  where id = p_group_id
  returning * into v_group;

  return v_group;
end;
$$;

-- Toggles a group's debt-simplification preference. Any member may change it
-- (mirrors rename_group). When true, the app shows greedy minimum-transfer
-- suggestions; when false, the raw pairwise ledger is shown instead.
create or replace function public.set_group_simplify_debts(
  p_group_id uuid,
  p_enabled boolean
)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups;
  v_new boolean := coalesce(p_enabled, true);
  v_old boolean;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  select simplify_debts into v_old
  from public.groups
  where id = p_group_id;

  update public.groups
  set simplify_debts = v_new
  where id = p_group_id
  returning * into v_group;

  -- Record the change so the Activity feed can surface it. Only when the value
  -- actually flips, so a no-op toggle does not spam the feed.
  if v_old is distinct from v_new then
    insert into public.group_simplify_debts_events (group_id, actor_id, enabled)
    values (p_group_id, v_uid, v_new);
  end if;

  return v_group;
end;
$$;

-- Raw pairwise "who owes whom" for the whole group (all member pairs, not just
-- the caller). Nets every unordered pair from expenses + settle-up payments
-- using base_amount, then emits one directed debtor->creditor edge per pair
-- with a non-trivial balance. Used when a group has debt simplification OFF.
create or replace function public.get_group_pairwise_balances(p_group_id uuid)
returns table (
  from_user uuid,
  from_name text,
  to_user uuid,
  to_name text,
  amount numeric(12, 2)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  return query
  with raw_debts as (
    -- Expense: the member with a split (dr) owes the payer (cr).
    select es.user_id as dr, e.paid_by as cr, es.base_amount as amt
    from public.expenses e
    join public.expense_splits es on es.expense_id = e.id
    where e.group_id = p_group_id and es.user_id <> e.paid_by and e.date <= now()
    union all
    -- Settle-up payment from paid_by to paid_to reduces paid_by's debt, i.e.
    -- it is equivalent to paid_to owing paid_by the paid amount.
    select pmt.paid_to as dr, pmt.paid_by as cr, pmt.base_amount as amt
    from public.payments pmt
    where pmt.group_id = p_group_id and pmt.date <= now()
  ),
  pair_net as (
    select
      least(rd.dr, rd.cr) as u_lo,
      greatest(rd.dr, rd.cr) as u_hi,
      -- Positive net means u_lo owes u_hi.
      sum(case when rd.dr < rd.cr then rd.amt else -rd.amt end) as net_lo
    from raw_debts rd
    group by 1, 2
  ),
  edges as (
    select
      case when pn.net_lo > 0 then pn.u_lo else pn.u_hi end as from_user,
      case when pn.net_lo > 0 then pn.u_hi else pn.u_lo end as to_user,
      round(abs(pn.net_lo), 2)::numeric(12, 2) as amount
    from pair_net pn
    where abs(pn.net_lo) > 0.005
  )
  select ed.from_user, pf.full_name, ed.to_user, pt.full_name, ed.amount
  from edges ed
  join public.profiles pf on pf.id = ed.from_user
  join public.profiles pt on pt.id = ed.to_user
  order by pf.full_name, pt.full_name;
end;
$$;

-- Minimal settlement plan for a group: one directed debtor->creditor edge set
-- derived from each member's net balance (get_group_balances). Deterministic so
-- every surface (group screen, contact breakdown, contacts list) agrees: debtors
-- are matched most-negative-first, creditors most-positive-first, ties broken by
-- user_id. The sum of a member's edges always equals their net balance, so this
-- is display-only and never changes anyone's overall position.
create or replace function public.get_group_simplified_edges(p_group_id uuid)
returns table (
  from_user uuid,
  from_name text,
  to_user uuid,
  to_name text,
  amount numeric(12, 2)
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_debtors uuid[];
  v_debt_amt numeric[];
  v_creditors uuid[];
  v_cred_amt numeric[];
  i int := 1;
  j int := 1;
  v_transfer numeric;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  -- Debtors (negative net) ordered most-negative first, then user_id.
  select
    array_agg(b.user_id order by b.balance asc, b.user_id asc),
    array_agg((-b.balance) order by b.balance asc, b.user_id asc)
  into v_debtors, v_debt_amt
  from public.get_group_balances(p_group_id) b
  where b.balance < -0.005;

  -- Creditors (positive net) ordered most-positive first, then user_id.
  select
    array_agg(b.user_id order by b.balance desc, b.user_id asc),
    array_agg(b.balance order by b.balance desc, b.user_id asc)
  into v_creditors, v_cred_amt
  from public.get_group_balances(p_group_id) b
  where b.balance > 0.005;

  if v_debtors is null or v_creditors is null then
    return;
  end if;

  while i <= array_length(v_debtors, 1) and j <= array_length(v_creditors, 1) loop
    -- Round once up front so the emitted edge and the running remainders stay in
    -- lockstep (no sub-cent residual can inflate a later edge by a penny).
    v_transfer := round(least(v_debt_amt[i], v_cred_amt[j]), 2);

    if v_transfer > 0.005 then
      from_user := v_debtors[i];
      to_user := v_creditors[j];
      amount := v_transfer;
      select p.full_name into from_name from public.profiles p where p.id = v_debtors[i];
      select p.full_name into to_name from public.profiles p where p.id = v_creditors[j];
      return next;
    end if;

    v_debt_amt[i] := v_debt_amt[i] - v_transfer;
    v_cred_amt[j] := v_cred_amt[j] - v_transfer;
    if v_debt_amt[i] <= 0.005 then i := i + 1; end if;
    if v_cred_amt[j] <= 0.005 then j := j + 1; end if;
  end loop;

  return;
end;
$$;

-- Same contact set as get_contacts_with_balances, but returns the combined
-- balance broken into per-currency context rows (1-on-1 ledger + each shared
-- group), un-summed. The client converts each row into the display currency and
-- sums per contact. full_name/avatar_url repeat across a contact's rows.
-- contact_deleted_at (the last column) is the contact's profiles.deleted_at: set when
-- that person deleted their account, so the client can stop offering them in new
-- expenses (the server refuses a new expense that names a deleted user).
create or replace function public.get_contacts_with_combined_balances()
returns table (
  contact_user_id uuid,
  full_name text,
  avatar_url text,
  currency text,
  balance numeric(12, 2),
  is_accepted boolean,
  contact_deleted_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return query
  with accepted as (
    select c.contact_user_id as uid
    from public.contacts c
    where c.owner_id = v_uid
  ),
  contact_ids as (
    select uid from accepted
    union
    select case when ce.user_lo = v_uid then ce.user_hi else ce.user_lo end as uid
    from public.contact_expenses ce
    where ce.user_lo = v_uid or ce.user_hi = v_uid
    union
    select case when cp.user_lo = v_uid then cp.user_hi else cp.user_lo end as uid
    from public.contact_payments cp
    where cp.user_lo = v_uid or cp.user_hi = v_uid
    union
    -- Group-mates: anyone sharing a group with the caller (covers simplified
    -- "phantom" debts and direct group balances with non-contacts).
    select gm2.user_id as uid
    from public.group_members gm1
    join public.group_members gm2 on gm2.group_id = gm1.group_id
    where gm1.user_id = v_uid and gm2.user_id <> v_uid
  ),
  contacts_resolved as (
    select
      ci.uid,
      p.full_name,
      p.avatar_url,
      (ci.uid in (select a.uid from accepted a)) as is_accepted,
      p.deleted_at
    from contact_ids ci
    join public.profiles p on p.id = ci.uid
    where ci.uid <> v_uid
  )
  select
    cr.uid,
    cr.full_name,
    cr.avatar_url,
    ctx.currency,
    ctx.balance,
    cr.is_accepted,
    cr.deleted_at
  from contacts_resolved cr
  cross join lateral public.get_contact_balance_contexts(cr.uid) ctx
  where cr.is_accepted or abs(ctx.balance) > 0.005
  order by cr.full_name;
end;
$$;

-- Per-group pairwise balance between the caller and a contact, for groups they
-- both belong to that have pairwise activity. Same sign rules as
-- get_contact_group_balance (positive = the contact owes you), but broken out
-- one row per group so the contact page can show a card per shared group.
create or replace function public.get_contact_group_breakdown(p_contact_user_id uuid)
returns table (
  group_id uuid,
  group_name text,
  balance numeric(12, 2),
  currency text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_contact_user_id is null or p_contact_user_id = v_uid then
    return;
  end if;

  return query
  with shared_groups as (
    select g.id as gid, g.name, g.currency, g.simplify_debts
    from public.groups g
    where g.id in (
      select gm.group_id from public.group_members gm where gm.user_id = v_uid
      intersect
      select gm.group_id from public.group_members gm where gm.user_id = p_contact_user_id
    )
  ),
  -- Direct pairwise (toggle OFF): only expenses/payments between the two of us.
  direct_expense as (
    select e.group_id as gid, sum(
      case
        when e.paid_by = v_uid and es.user_id = p_contact_user_id then es.base_amount
        when e.paid_by = p_contact_user_id and es.user_id = v_uid then -es.base_amount
        else 0
      end
    ) as bal
    from public.expenses e
    join public.expense_splits es on es.expense_id = e.id
    where e.group_id in (select sg.gid from shared_groups sg where not simplify_debts)
      and e.date <= now()
      and (
        (e.paid_by = v_uid and es.user_id = p_contact_user_id)
        or (e.paid_by = p_contact_user_id and es.user_id = v_uid)
      )
    group by e.group_id
  ),
  direct_payment as (
    select pmt.group_id as gid, sum(
      case
        when pmt.paid_by = v_uid and pmt.paid_to = p_contact_user_id then pmt.base_amount
        when pmt.paid_by = p_contact_user_id and pmt.paid_to = v_uid then -pmt.base_amount
        else 0
      end
    ) as bal
    from public.payments pmt
    where pmt.group_id in (select sg.gid from shared_groups sg where not simplify_debts)
      and pmt.date <= now()
      and (
        (pmt.paid_by = v_uid and pmt.paid_to = p_contact_user_id)
        or (pmt.paid_by = p_contact_user_id and pmt.paid_to = v_uid)
      )
    group by pmt.group_id
  ),
  -- Simplified edge (toggle ON): the you<->contact edge in the minimal plan.
  simplified as (
    select sg.gid, sum(
      case
        when e.from_user = p_contact_user_id and e.to_user = v_uid then e.amount
        when e.from_user = v_uid and e.to_user = p_contact_user_id then -e.amount
        else 0
      end
    ) as bal
    from shared_groups sg
    cross join lateral public.get_group_simplified_edges(sg.gid) e
    where sg.simplify_debts
    group by sg.gid
  ),
  per_group as (
    select de.gid, de.bal from direct_expense de
    union all
    select dp.gid, dp.bal from direct_payment dp
    union all
    select s.gid, s.bal from simplified s
  ),
  totals as (
    select pg.gid, sum(pg.bal) as bal from per_group pg group by pg.gid
  )
  select sg.gid, sg.name, round(coalesce(t.bal, 0), 2)::numeric(12, 2), sg.currency
  from shared_groups sg
  left join totals t on t.gid = sg.gid
  where abs(coalesce(t.bal, 0)) > 0.005
  order by sg.name;
end;
$$;

-- Returns the user's net balance in each context, un-summed: one row per group
-- (their net in that group, in the group's base currency) plus one row per
-- one-on-one contact ledger (in the pair's base currency). The client converts
-- each row into the display currency before summing into owed/owing, since the
-- contexts can be in different currencies. Group activity is counted only via
-- the group rows; contact rows are the 1-on-1 ledger only (no double counting).
create or replace function public.get_user_total_balance(p_user_id uuid)
returns table (
  balance numeric(12, 2),
  currency text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_user_id <> auth.uid() then
    raise exception 'You can only view your own total balance';
  end if;

  -- Group contexts: my net per group, in that group's base currency.
  return query
  with user_groups as (
    select gm.group_id as gid from public.group_members gm where gm.user_id = p_user_id
  )
  select gb.balance, g.currency
  from user_groups ug
  join public.groups g on g.id = ug.gid
  cross join lateral public.get_group_balances(ug.gid) gb
  where gb.user_id = p_user_id;

  -- One-on-one contact ledger contexts, in each pair's base currency.
  return query
  select cwb.balance, public.get_contact_currency(cwb.contact_user_id)
  from public.get_contacts_with_balances() cwb;
end;
$$;

-- Records a group settle-up payment.
--
-- Payments are entered in the group's base currency at a rate of 1, so the
-- currency and base_amount are derived here rather than trusted from the
-- caller: a payment booked in a currency the group never converts would land
-- in get_group_balances at face value and silently move everyone's numbers.
create or replace function public.create_payment(
  p_group_id uuid,
  p_paid_by uuid,
  p_paid_to uuid,
  p_amount numeric,
  p_note text default null,
  p_currency text default null,
  p_date timestamptz default null
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_payment public.payments;
  v_currency text;
  v_amount numeric(12, 2);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  if not public.is_group_member(p_group_id, p_paid_by)
    or not public.is_group_member(p_group_id, p_paid_to)
  then
    raise exception 'Both people must be group members';
  end if;

  if v_uid <> p_paid_by and v_uid <> p_paid_to then
    raise exception 'You can only record payments you are part of';
  end if;

  if p_paid_by = p_paid_to then
    raise exception 'Payer and recipient must be different people';
  end if;

  if p_amount is null or p_amount <= 0
    or p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Payment amount must be greater than zero';
  end if;

  select g.currency into v_currency from public.groups g where g.id = p_group_id;

  if p_currency is not null and upper(btrim(p_currency)) <> v_currency then
    raise exception 'Payments must be recorded in the group currency (%)', v_currency;
  end if;

  v_amount := round(p_amount, 2);

  insert into public.payments (
    group_id, paid_by, paid_to, amount, note, currency, exchange_rate, base_amount, date
  )
  values (
    p_group_id, p_paid_by, p_paid_to, v_amount, p_note, v_currency, 1, v_amount,
    coalesce(p_date, now())
  )
  returning * into v_payment;

  return v_payment;
end;
$$;

-- Edits a group settle-up payment. Only someone on one side of the payment may
-- change it, before and after the edit -- the same rule that governs recording
-- one. base_amount is recomputed from the rate the payment was booked at, so
-- an edit can never leave the converted amount out of step with the face value.
create or replace function public.update_payment(
  p_payment_id uuid,
  p_paid_by uuid,
  p_paid_to uuid,
  p_amount numeric,
  p_note text default null,
  p_date timestamptz default null
)
returns public.payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.payments;
  v_payment public.payments;
  v_amount numeric(12, 2);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_existing from public.payments where id = p_payment_id;

  if not found then
    raise exception 'Payment not found';
  end if;

  if v_uid <> v_existing.paid_by and v_uid <> v_existing.paid_to then
    raise exception 'You can only edit payments you are part of';
  end if;

  if v_uid <> p_paid_by and v_uid <> p_paid_to then
    raise exception 'You cannot move a payment to two other people';
  end if;

  if not public.is_group_member(v_existing.group_id, p_paid_by)
    or not public.is_group_member(v_existing.group_id, p_paid_to)
  then
    raise exception 'Both people must be group members';
  end if;

  if p_paid_by = p_paid_to then
    raise exception 'Payer and recipient must be different people';
  end if;

  if p_amount is null or p_amount <= 0
    or p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Payment amount must be greater than zero';
  end if;

  v_amount := round(p_amount, 2);

  update public.payments
  set
    paid_by = p_paid_by,
    paid_to = p_paid_to,
    amount = v_amount,
    note = p_note,
    base_amount = round(v_amount * v_existing.exchange_rate, 2),
    date = coalesce(p_date, date)
  where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

-- Deletes a group settle-up payment. Any member of the group may delete, which
-- mirrors the relaxed delete model used for expenses.
create or replace function public.delete_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select group_id into v_group_id from public.payments where id = p_payment_id;

  if v_group_id is null then
    raise exception 'Payment not found';
  end if;

  if not public.is_group_member(v_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  delete from public.payments where id = p_payment_id;
end;
$$;

-- Deletes a group expense (its splits cascade). Any member of the group may
-- delete, matching the previous relaxed delete policy.
create or replace function public.delete_expense(p_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select group_id into v_group_id from public.expenses where id = p_expense_id;

  if v_group_id is null then
    raise exception 'Expense not found';
  end if;

  if not public.is_group_member(v_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  delete from public.expenses where id = p_expense_id;
end;
$$;

-- Records a one-on-one settle-up payment. Mirrors create_payment: the pair must
-- be accepted contacts, the caller must be one of the two, and the currency and
-- base_amount come from the pair's setting rather than from the caller.
create or replace function public.create_contact_payment(
  p_contact_user_id uuid,
  p_paid_by uuid,
  p_paid_to uuid,
  p_amount numeric,
  p_note text default null,
  p_currency text default null,
  p_date timestamptz default null
)
returns public.contact_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_payment public.contact_payments;
  v_lo uuid;
  v_hi uuid;
  v_currency text;
  v_amount numeric(12, 2);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_contact_user_id is null or p_contact_user_id = v_uid then
    raise exception 'Invalid contact';
  end if;

  if not exists (
    select 1 from public.contacts
    where owner_id = v_uid and contact_user_id = p_contact_user_id
  ) then
    raise exception 'You can only record payments with accepted contacts';
  end if;

  if p_paid_by = p_paid_to then
    raise exception 'Payer and recipient must be different people';
  end if;

  if p_paid_by not in (v_uid, p_contact_user_id)
    or p_paid_to not in (v_uid, p_contact_user_id)
  then
    raise exception 'A payment must be between you and the contact';
  end if;

  if p_amount is null or p_amount <= 0
    or p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Payment amount must be greater than zero';
  end if;

  if v_uid < p_contact_user_id then
    v_lo := v_uid;
    v_hi := p_contact_user_id;
  else
    v_lo := p_contact_user_id;
    v_hi := v_uid;
  end if;

  v_currency := public.get_contact_currency(p_contact_user_id);

  if p_currency is not null and upper(btrim(p_currency)) <> v_currency then
    raise exception 'Payments must be recorded in the contact currency (%)', v_currency;
  end if;

  v_amount := round(p_amount, 2);

  insert into public.contact_payments (
    paid_by, paid_to, user_lo, user_hi, amount, note,
    currency, exchange_rate, base_amount, date
  )
  values (
    p_paid_by, p_paid_to, v_lo, v_hi, v_amount, p_note,
    v_currency, 1, v_amount, coalesce(p_date, now())
  )
  returning * into v_payment;

  return v_payment;
end;
$$;

-- Edits a one-on-one settle-up payment. The participant pair is immutable; only
-- direction, amount, note and date change, and only a participant may edit.
create or replace function public.update_contact_payment(
  p_payment_id uuid,
  p_paid_by uuid,
  p_paid_to uuid,
  p_amount numeric,
  p_note text default null,
  p_date timestamptz default null
)
returns public.contact_payments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_existing public.contact_payments;
  v_payment public.contact_payments;
  v_amount numeric(12, 2);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_existing from public.contact_payments where id = p_payment_id;

  if not found then
    raise exception 'Payment not found';
  end if;

  if v_uid <> v_existing.user_lo and v_uid <> v_existing.user_hi then
    raise exception 'You are not a participant in this payment';
  end if;

  if p_paid_by = p_paid_to then
    raise exception 'Payer and recipient must be different people';
  end if;

  if p_paid_by not in (v_existing.user_lo, v_existing.user_hi)
    or p_paid_to not in (v_existing.user_lo, v_existing.user_hi)
  then
    raise exception 'A payment must be between the two participants';
  end if;

  if p_amount is null or p_amount <= 0
    or p_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Payment amount must be greater than zero';
  end if;

  v_amount := round(p_amount, 2);

  update public.contact_payments
  set
    paid_by = p_paid_by,
    paid_to = p_paid_to,
    amount = v_amount,
    note = p_note,
    base_amount = round(v_amount * v_existing.exchange_rate, 2),
    date = coalesce(p_date, date)
  where id = p_payment_id
  returning * into v_payment;

  return v_payment;
end;
$$;

-- Deletes a one-on-one settle-up payment. Either participant may delete.
create or replace function public.delete_contact_payment(p_payment_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_lo uuid;
  v_hi uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select user_lo, user_hi into v_lo, v_hi
  from public.contact_payments where id = p_payment_id;

  if v_lo is null then
    raise exception 'Payment not found';
  end if;

  if v_uid <> v_lo and v_uid <> v_hi then
    raise exception 'You are not a participant in this payment';
  end if;

  delete from public.contact_payments where id = p_payment_id;
end;
$$;

-- Deletes a one-on-one contact expense (its splits cascade). Either participant
-- may delete.
create or replace function public.delete_contact_expense(p_expense_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_lo uuid;
  v_hi uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select user_lo, user_hi into v_lo, v_hi
  from public.contact_expenses where id = p_expense_id;

  if v_lo is null then
    raise exception 'Expense not found';
  end if;

  if v_uid <> v_lo and v_uid <> v_hi then
    raise exception 'You are not a participant in this expense';
  end if;

  delete from public.contact_expenses where id = p_expense_id;
end;
$$;

-- Updates the caller's own profile. The last write path that still went
-- directly to a table; routing it through an RPC keeps the rule uniform (every
-- write is a SECURITY DEFINER function) and gives the display name the same
-- non-empty check the client applies, which `full_name text not null` alone
-- does not enforce.
create or replace function public.update_profile(
  p_full_name text,
  p_avatar_url text default null
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_profile public.profiles;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if btrim(coalesce(p_full_name, '')) = '' then
    raise exception 'Name is required';
  end if;

  update public.profiles
  set
    full_name = btrim(p_full_name),
    avatar_url = coalesce(p_avatar_url, avatar_url)
  where id = v_uid
  returning * into v_profile;

  return v_profile;
end;
$$;

-- Recurring engine. The n-th occurrence date is start + n * step, computed from
-- the start date and never chained from the previous one, so a monthly series
-- on the 31st clamps to the month end and returns to the 31st. Postgres does
-- the clamping when a month or year interval lands on a missing day.
create or replace function public._occurrence_date(
  p_start date,
  p_frequency text,
  p_n int
)
returns date
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_frequency
    when 'daily' then p_start + p_n
    when 'weekly' then p_start + 7 * p_n
    when 'biweekly' then p_start + 14 * p_n
    when 'monthly' then (p_start + p_n * interval '1 month')::date
    when 'yearly' then (p_start + p_n * interval '1 year')::date
  end
$$;

revoke execute on function public._occurrence_date(date, text, int)
  from public, anon, authenticated;

-- The rate a recurring occurrence converts at: base units per 1 unit of the
-- schedule's currency, the client's getRate(from = currency, to = base), i.e.
-- rates[base] / rates[currency] from the latest row with day <= today (UTC) that
-- is at most 7 days old. The base is the group's currency, or the contact pair's
-- (USD when it has no setting), as in _materialise_one. Same currency is 1. The
-- rate is not rounded. Anything unusable (no recent row, a currency or the base
-- missing, a non-positive or non-numeric rate, a pair rate the numeric(18,8)
-- exchange_rate column cannot hold) falls back to last_exchange_rate. It never
-- raises: any error (such as a numeric overflow from a row written outside the
-- store function) is caught and the fallback returned.
create or replace function public._schedule_rate(p_schedule public.recurring_schedules)
returns numeric
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_base text;
  v_today date := (now() at time zone 'UTC')::date;
  v_rates jsonb;
  v_from numeric;
  v_to numeric;
  v_rate numeric;
begin
  begin
    if p_schedule.kind = 'group' then
      select g.currency into v_base from public.groups g where g.id = p_schedule.group_id;
    elsif p_schedule.kind = 'contact' then
      select s.currency into v_base from public.contact_pair_settings s
      where s.user_lo = p_schedule.user_lo and s.user_hi = p_schedule.user_hi;
      v_base := coalesce(v_base, 'USD');
    end if;

    if v_base is null then
      return p_schedule.last_exchange_rate;
    end if;
    if upper(btrim(p_schedule.currency)) = upper(btrim(v_base)) then
      return 1;
    end if;

    select r.rates into v_rates
    from public.exchange_rates r
    where r.day <= v_today and r.day >= v_today - 7
    order by r.day desc
    limit 1;

    if v_rates is not null
      and jsonb_typeof(v_rates -> upper(btrim(p_schedule.currency))) = 'number'
      and jsonb_typeof(v_rates -> upper(btrim(v_base))) = 'number' then
      v_from := (v_rates ->> upper(btrim(p_schedule.currency)))::numeric;
      v_to := (v_rates ->> upper(btrim(v_base)))::numeric;
      if v_from > 0 and v_to > 0 then
        v_rate := v_to / v_from;
        if v_rate >= 0.000001 and v_rate < 1000000000 then
          return v_rate;
        end if;
      end if;
    end if;
  exception when others then
    return p_schedule.last_exchange_rate;
  end;

  return p_schedule.last_exchange_rate;
end;
$$;

revoke execute on function public._schedule_rate(public.recurring_schedules)
  from public, anon, authenticated;

-- Step one of the refresh: ask pg_net to GET the rates, and record the request id
-- it returns so step two reads only the response to this request (pg_net is
-- asynchronous: the request runs after this statement's transaction commits and
-- the answer lands in net._http_response, which every pg_net user shares). Records
-- older than 7 days are pruned here. net.* is only referenced through dynamic SQL,
-- so this function can be created, and does nothing, on a project without pg_net.
-- Returns pg_net's request id, or null.
create or replace function public._refresh_exchange_rates_fire()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_url constant text := 'https://open.er-api.com/v6/latest/USD';
  v_id bigint;
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'net' and p.proname = 'http_get'
  ) then
    return null;
  end if;

  delete from public.exchange_rate_requests where requested_at < now() - interval '7 days';

  execute 'select net.http_get(url := $1, timeout_milliseconds := 10000)' into v_id using c_url;
  if v_id is not null then
    insert into public.exchange_rate_requests (id) values (v_id)
    on conflict (id) do update set requested_at = now();
  end if;
  return v_id;
end;
$$;

revoke execute on function public._refresh_exchange_rates_fire()
  from public, anon, authenticated;

-- Step two: take the response to the newest request _refresh_exchange_rates_fire
-- made in the last hour (only responses to recorded request ids are read; other
-- pg_net traffic is ignored), validate it and upsert today's (UTC) row. Rejected,
-- and nothing written, when: there is no recent request or no response to it yet;
-- the fetch timed out or failed (no status); the status is not 200; the body is
-- not a JSON object; result is not 'success'; rates is not a non-empty object of
-- numbers between 1e-9 and 1e9 (positive and sane: units of a currency per USD);
-- USD is not exactly 1; or any currency moved more than 50% against the latest row
-- from the previous 7 days (a one-off bad payload cannot replace good rates; a
-- baseline older than that is no baseline, so a real devaluation cannot lock the
-- refresh out for good). Returns 'stored' or the reason it did not store. Every
-- rejection is also a generic WARNING in the Postgres log (the reason only: never
-- the response body or pg_net's error text). Does nothing, without raising, when
-- pg_net is absent.
create or replace function public._refresh_exchange_rates_store()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'UTC')::date;
  v_request bigint;
  v_content text;
  v_status int;
  v_found boolean;
  v_body jsonb;
  v_rates jsonb;
  v_prev jsonb;
  v_bad int;
  v_reason text;
begin
  if to_regclass('net._http_response') is null then
    return 'pg_net is not available';
  end if;

  select r.id into v_request
  from public.exchange_rate_requests r
  where r.requested_at > now() - interval '1 hour'
  order by r.requested_at desc, r.id desc
  limit 1;

  if v_request is null then
    v_reason := 'no recent request';
  else
    execute 'select true, status_code, content from net._http_response where id = $1'
      into v_found, v_status, v_content using v_request;
    if v_found is not true then
      v_reason := 'no response to the latest request yet';
    elsif v_status is null then
      v_reason := 'the fetch failed or timed out';
    elsif v_status <> 200 then
      v_reason := 'the fetch returned status ' || v_status;
    end if;
  end if;

  if v_reason is null then
    begin
      v_body := v_content::jsonb;
    exception when others then
      v_reason := 'the response is not JSON';
    end;
  end if;

  if v_reason is null then
    v_rates := case when jsonb_typeof(v_body) = 'object' then v_body -> 'rates' end;
    if jsonb_typeof(v_body) is distinct from 'object' then
      v_reason := 'the response is not an object';
    elsif v_body ->> 'result' is distinct from 'success' then
      v_reason := 'the response is not a success';
    elsif jsonb_typeof(v_rates) is distinct from 'object' or v_rates = '{}'::jsonb then
      v_reason := 'rates is not a non-empty object';
    else
      select count(*) into v_bad
      from jsonb_each(v_rates) e
      where case when jsonb_typeof(e.value) = 'number'
        then (e.value #>> '{}')::numeric not between 0.000000001 and 1000000000 else true end;
      if v_bad > 0 then
        v_reason := v_bad || ' rate(s) are not numbers between 1e-9 and 1e9';
      elsif jsonb_typeof(v_rates -> 'USD') is distinct from 'number'
        or (v_rates ->> 'USD')::numeric <> 1 then
        v_reason := 'the USD rate is not 1';
      end if;
    end if;
  end if;

  if v_reason is null then
    select r.rates into v_prev
    from public.exchange_rates r
    where r.day < v_today and r.day >= v_today - 7
    order by r.day desc
    limit 1;

    if v_prev is not null then
      select count(*) into v_bad
      from jsonb_each(v_rates) n
      join jsonb_each(v_prev) o on o.key = n.key
      where case
        when jsonb_typeof(o.value) = 'number' then
          case
            when (o.value #>> '{}')::numeric > 0
              then abs((n.value #>> '{}')::numeric / (o.value #>> '{}')::numeric - 1) > 0.5
            else false
          end
        else false
      end;
      if v_bad > 0 then
        v_reason := v_bad || ' rate(s) moved more than 50% since the previous day';
      end if;
    end if;
  end if;

  if v_reason is not null then
    raise warning 'exchange rates not stored: %', v_reason;
    return 'not stored: ' || v_reason;
  end if;

  insert into public.exchange_rates (day, rates, fetched_at)
  values (v_today, v_rates, now())
  on conflict (day) do update set rates = excluded.rates, fetched_at = excluded.fetched_at;

  return 'stored';
end;
$$;

revoke execute on function public._refresh_exchange_rates_store()
  from public, anon, authenticated;

-- Port of the client's convertSplitsToBase (lib/utils.ts): each split's base
-- amount is round(amount * rate, 2) and the rounding remainder against
-- p_base_total goes to the first largest split, so the base amounts add up to
-- the converted total exactly. Any stored baseAmount in p_splits is ignored.
create or replace function public._convert_splits_to_base(
  p_splits jsonb,
  p_rate numeric,
  p_base_total numeric
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_n int := jsonb_array_length(p_splits);
  v_amounts numeric[] := '{}';
  v_bases numeric[] := '{}';
  v_sum numeric := 0;
  v_remainder numeric;
  v_target int := 1;
  v_out jsonb := '[]'::jsonb;
  i int;
begin
  for i in 1..v_n loop
    v_amounts[i] := round((p_splits->(i - 1)->>'amount')::numeric, 2);
    v_bases[i] := round(v_amounts[i] * p_rate, 2);
    v_sum := v_sum + v_bases[i];
  end loop;

  v_remainder := p_base_total - v_sum;
  if v_remainder <> 0 and v_n > 0 then
    for i in 2..v_n loop
      if v_bases[i] > v_bases[v_target] then
        v_target := i;
      end if;
    end loop;
    v_bases[v_target] := v_bases[v_target] + v_remainder;
  end if;

  for i in 1..v_n loop
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'userId', p_splits->(i - 1)->>'userId',
      'amount', v_amounts[i],
      'baseAmount', v_bases[i]
    ));
  end loop;

  return v_out;
end;
$$;

revoke execute on function public._convert_splits_to_base(jsonb, numeric, numeric)
  from public, anon, authenticated;

-- Creates the occurrences of one schedule that are due by p_horizon, walking
-- from its cursor (next_index), which only ever grows: that is what makes a
-- deleted occurrence stay skipped. An occurrence is due when the start of its
-- local day (in the schedule's tz) is at or before p_horizon. Each expense is
-- inserted for paid_by through the shared helper, dated its own local midnight;
-- one that already exists (same schedule and date) counts as made. Stops the
-- schedule as 'completed' once max_count or end_date is reached. Raises on any
-- problem (EVNTM: someone left, EVNTI: invalid schedule, or the helper's own
-- errors); _materialise_recurring decides what to do with the schedule.
-- Returns the number of expenses created.
-- Occurrences are created up to p_horizon (48 hours by default) ahead of their
-- instant. That is safe only because balances ignore rows dated in the future
-- (`date <= now()` in the balance functions, from the future-dated lane, PR #13):
-- without it a row created early would count early.
create or replace function public._materialise_one(
  p_schedule_id uuid,
  p_horizon timestamptz
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_cap constant int := 400;
  v_s public.recurring_schedules;
  v_base text;
  v_other uuid;
  v_member uuid;
  v_rate numeric;
  v_splits jsonb;
  v_idx int;
  v_steps int := 0;
  v_made int := 0;
  v_occ date;
  v_at timestamptz;
  v_done boolean := false;
  v_constraint text;
begin
  select * into v_s from public.recurring_schedules where id = p_schedule_id for update;
  if not found or v_s.stopped_at is not null then
    return 0;
  end if;

  if v_s.kind = 'group' then
    if not public.is_group_member(v_s.group_id, v_s.paid_by)
      or exists (select 1 from public.profiles p where p.id = v_s.paid_by and p.deleted_at is not null) then
      raise exception 'schedule member left' using errcode = 'EVNTM';
    end if;
    for v_member in
      select distinct (e->>'userId')::uuid from jsonb_array_elements(v_s.splits) e
    loop
      if not public.is_group_member(v_s.group_id, v_member)
        or exists (select 1 from public.profiles p where p.id = v_member and p.deleted_at is not null) then
        raise exception 'schedule member left' using errcode = 'EVNTM';
      end if;
    end loop;
    select g.currency into v_base from public.groups g where g.id = v_s.group_id;
    if not found then
      raise exception 'schedule invalid' using errcode = 'EVNTI';
    end if;
  else
    if v_s.paid_by <> v_s.user_lo and v_s.paid_by <> v_s.user_hi then
      raise exception 'schedule invalid' using errcode = 'EVNTI';
    end if;
    v_other := case when v_s.paid_by = v_s.user_lo then v_s.user_hi else v_s.user_lo end;
    if not exists (
      select 1 from public.contacts c
      where c.owner_id = v_s.paid_by and c.contact_user_id = v_other
    ) then
      raise exception 'schedule member left' using errcode = 'EVNTM';
    end if;
    if exists (
      select 1 from public.profiles p
      where p.id in (v_s.user_lo, v_s.user_hi) and p.deleted_at is not null
    ) then
      raise exception 'schedule member left' using errcode = 'EVNTM';
    end if;
    select s.currency into v_base from public.contact_pair_settings s
    where s.user_lo = v_s.user_lo and s.user_hi = v_s.user_hi;
    v_base := coalesce(v_base, 'USD');
  end if;

  if upper(btrim(v_s.currency)) = upper(btrim(v_base)) then
    v_rate := 1;
  else
    v_rate := public._schedule_rate(v_s);
  end if;
  v_splits := public._convert_splits_to_base(v_s.splits, v_rate, round(v_s.amount * v_rate, 2));

  v_idx := v_s.next_index;
  loop
    exit when v_steps >= c_cap;

    if v_s.max_count is not null and v_idx >= v_s.max_count then
      v_done := true;
      exit;
    end if;

    v_occ := public._occurrence_date(v_s.start_date, v_s.frequency, v_idx);
    if v_occ is null then
      raise exception 'schedule invalid' using errcode = 'EVNTI';
    end if;
    if v_s.end_date is not null and v_occ > v_s.end_date then
      v_done := true;
      exit;
    end if;

    v_at := v_occ::timestamp at time zone v_s.tz;
    exit when v_at > p_horizon;

    begin
      if v_s.kind = 'group' then
        perform public._insert_group_expense(
          v_s.paid_by, v_s.group_id, v_s.paid_by, v_s.amount, v_s.description, v_s.category,
          v_s.split_type, v_splits, v_at, v_s.currency, v_rate, v_s.id, v_occ
        );
      else
        perform public._insert_contact_expense(
          v_s.paid_by, v_other, v_s.paid_by, v_s.amount, v_s.description, v_s.category,
          v_s.split_type, v_splits, v_at, v_s.currency, v_rate, v_s.id, v_occ
        );
      end if;
      v_made := v_made + 1;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'idx_expenses_schedule_occurrence'
        and v_constraint is distinct from 'idx_contact_expenses_schedule_occurrence' then
        raise;
      end if;
    end;

    v_idx := v_idx + 1;
    v_steps := v_steps + 1;
  end loop;

  -- Write only what changed: a run with nothing due must leave the row alone (an
  -- update is WAL, a row lock and a realtime event for the whole group).
  update public.recurring_schedules s
  set
    next_index = v_idx,
    last_exchange_rate = case
      when v_made > 0 and upper(btrim(v_s.currency)) <> upper(btrim(v_base)) then v_rate
      else s.last_exchange_rate
    end,
    stopped_at = case when v_done then now() end,
    stop_reason = case when v_done then 'completed' end,
    failed_runs = 0,
    last_error = null
  where s.id = v_s.id
    and (
      v_idx is distinct from v_s.next_index
      or v_done
      or v_s.failed_runs <> 0
      or v_s.last_error is not null
      or (
        v_made > 0
        and upper(btrim(v_s.currency)) <> upper(btrim(v_base))
        and v_rate is distinct from v_s.last_exchange_rate
      )
    );

  return v_made;
end;
$$;

revoke execute on function public._materialise_one(uuid, timestamptz)
  from public, anon, authenticated;

-- The runner behind cron and the app-open catch-up: every active schedule (or,
-- with p_user_id, those that user is a member or participant of) goes through
-- _materialise_one in its own sub-transaction, so one schedule's failure never
-- blocks another. A deterministic problem (a member left, an invalid schedule)
-- stops that schedule with a generic stop_reason and last_error; anything else
-- (lock timeout, deadlock, serialization failure, and also SQLSTATEs such as
-- 42501, 42883, XX000 or P0002 that point at a bug or a permissions problem)
-- leaves it active, counts a failed run and is retried next time. There is
-- deliberately no ceiling: failed_runs is a visible counter, the schedule is
-- retried once per run and a failure never stops the series by itself. Raw error
-- text is never stored: members can read these columns. Returns the number of
-- expenses created.
create or replace function public._materialise_recurring(
  p_horizon timestamptz default now() + interval '48 hours',
  p_user_id uuid default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_horizon timestamptz := coalesce(p_horizon, now() + interval '48 hours');
  v_id uuid;
  v_total int := 0;
  v_state text;
begin
  for v_id in
    select s.id
    from public.recurring_schedules s
    where s.stopped_at is null
      and (
        p_user_id is null
        or (s.kind = 'group' and public.is_group_member(s.group_id, p_user_id))
        or (s.kind = 'contact' and p_user_id in (s.user_lo, s.user_hi))
      )
    order by s.created_at, s.id
  loop
    begin
      v_total := v_total + public._materialise_one(v_id, v_horizon);
    exception when others then
      get stacked diagnostics v_state = returned_sqlstate;
      if v_state = 'EVNTM' then
        perform public._stop_schedule_member_left(v_id);
      elsif v_state in ('EVNTI', 'P0001') or left(v_state, 2) in ('22', '23') then
        update public.recurring_schedules
        set stopped_at = now(), stop_reason = 'invalid',
          last_error = 'This repeating item was stopped.'
        where id = v_id and stopped_at is null;
      else
        update public.recurring_schedules
        set failed_runs = failed_runs + 1,
          last_error = 'Could not create the latest occurrence; it will be retried.'
        where id = v_id and stopped_at is null;
      end if;
    end;
  end loop;

  return v_total;
end;
$$;

revoke execute on function public._materialise_recurring(timestamptz, uuid)
  from public, anon, authenticated;

-- App-open catch-up for the signed-in user: the same runner cron uses, scoped
-- to the schedules the caller belongs to, with the real clock. Idempotent, so it
-- is safe to run on every app open; covers pg_cron being off or a paused project.
create or replace function public.materialise_my_recurring()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  return public._materialise_recurring(now() + interval '48 hours', v_uid);
end;
$$;

revoke execute on function public.materialise_my_recurring() from public, anon;
grant execute on function public.materialise_my_recurring() to authenticated;

-- Creates a repeating expense. Exactly one of p_group_id / p_contact_id is set;
-- p_contact_id is the OTHER person's profile id (the pair is derived from the
-- caller, and must be accepted contacts). The payload is the create-expense
-- payload: p_paid_by and p_splits ([{userId, amount}]; only those two keys are
-- stored, any baseAmount is ignored) are validated here by running the first occurrence through the
-- expense insert helper and rolling it back, so a schedule that would fail to
-- materialise is refused up front even when it starts weeks from now.
-- p_exchange_rate (null means 1) is the rate when it was created; it seeds
-- last_exchange_rate. p_start_date is a calendar date in p_tz (an IANA name), at
-- most 31 days in the past (those occurrences are created now, dated their own
-- day) and at most a year ahead. p_end_date and p_max_count may both be set; the
-- first limit reached ends the series. Occurrences up to 48 hours ahead are
-- created before returning, unwrapped: any failure rolls the whole call back.
-- Returns the schedule as stored after that first run (the cursor has moved).
create or replace function public.create_recurring_schedule(
  p_group_id uuid,
  p_contact_id uuid,
  p_paid_by uuid,
  p_amount numeric,
  p_description text,
  p_category text,
  p_split_type public.split_type,
  p_splits jsonb,
  p_currency text,
  p_exchange_rate numeric,
  p_start_date date,
  p_tz text,
  p_frequency text,
  p_end_date date default null,
  p_max_count int default null
)
returns public.recurring_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_lo uuid;
  v_hi uuid;
  v_base text;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
  v_rate numeric := coalesce(p_exchange_rate, 1);
  v_effective_rate numeric;
  v_amount numeric;
  v_split jsonb;
  v_norm jsonb;
  v_splits jsonb;
  v_today date;
  v_id uuid;
  v_schedule public.recurring_schedules;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if (p_group_id is null) = (p_contact_id is null) then
    raise exception 'Choose either a group or a contact for a repeating expense';
  end if;

  if p_group_id is not null then
    if not public.is_group_member(p_group_id, v_uid) then
      raise exception 'You are not a member of this group';
    end if;

    select g.currency into v_base from public.groups g where g.id = p_group_id;
  else
    if p_contact_id = v_uid then
      raise exception 'Invalid contact';
    end if;

    if not exists (
      select 1 from public.contacts
      where owner_id = v_uid and contact_user_id = p_contact_id
    ) then
      raise exception 'You can only add expenses with accepted contacts';
    end if;

    v_lo := least(v_uid, p_contact_id);
    v_hi := greatest(v_uid, p_contact_id);

    select s.currency into v_base
    from public.contact_pair_settings s
    where s.user_lo = v_lo and s.user_hi = v_hi;
    v_base := coalesce(v_base, 'USD');
  end if;

  if p_frequency is null or p_frequency not in ('daily', 'weekly', 'biweekly', 'monthly', 'yearly') then
    raise exception 'Frequency must be daily, weekly, biweekly, monthly or yearly';
  end if;

  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    raise exception 'Time zone is not valid';
  end if;

  if p_paid_by is null then
    raise exception 'Expense payer is required';
  end if;

  if p_amount is null or p_amount <= 0
    or p_amount = 'NaN'::numeric or p_amount = 'Infinity'::numeric then
    raise exception 'Expense amount must be greater than zero';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Expense description is required';
  end if;

  if v_rate <= 0 or v_rate = 'NaN'::numeric or v_rate = 'Infinity'::numeric then
    raise exception 'Exchange rate must be greater than zero';
  end if;

  if p_split_type is null then
    raise exception 'Split type is required';
  end if;

  if jsonb_typeof(p_splits) is distinct from 'array' then
    raise exception 'Splits must be a list';
  end if;

  if jsonb_array_length(p_splits) = 0 then
    raise exception 'At least one split is required';
  end if;

  begin
    for v_split in select value from jsonb_array_elements(p_splits)
    loop
      if jsonb_typeof(v_split) is distinct from 'object'
        or v_split->>'userId' is null
        or v_split->>'amount' is null then
        raise exception 'Each split needs a user and an amount';
      end if;
      perform (v_split->>'userId')::uuid;
      v_amount := (v_split->>'amount')::numeric;
      if v_amount in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) then
        raise exception 'Each split needs a user and an amount';
      end if;
    end loop;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'Each split needs a user and an amount';
  end;

  if p_start_date is null then
    raise exception 'Start date is required';
  end if;

  v_today := (now() at time zone p_tz)::date;

  if p_start_date < v_today - 31 then
    raise exception 'Start date cannot be more than 31 days in the past';
  end if;

  if p_start_date > (v_today + interval '1 year')::date then
    raise exception 'Start date cannot be more than a year ahead';
  end if;

  if p_end_date is not null and p_end_date < p_start_date then
    raise exception 'End date cannot be before the start date';
  end if;

  if p_max_count is not null and p_max_count <= 0 then
    raise exception 'Number of repeats must be greater than zero';
  end if;

  -- Only [{userId, amount}] is kept: the user as the lowercase uuid text of the
  -- cast (so every later comparison sees one spelling) and the amount rounded to
  -- 2 places. Every other key is dropped, so a schedule row, which every member
  -- can read, never carries whatever else the client sent.
  select jsonb_agg(
    jsonb_build_object(
      'userId', ((t.e->>'userId')::uuid)::text,
      'amount', round((t.e->>'amount')::numeric, 2)
    )
    order by t.ord
  )
  into v_norm
  from jsonb_array_elements(p_splits) with ordinality as t(e, ord);

  -- Trial run: the first occurrence, converted the way the engine converts it,
  -- through the same helper (payer, split users, amounts and totals), then undone.
  v_effective_rate := case when v_currency = upper(btrim(v_base)) then 1 else v_rate end;
  v_splits := public._convert_splits_to_base(v_norm, v_effective_rate, round(p_amount * v_effective_rate, 2));

  begin
    if p_group_id is not null then
      perform public._insert_group_expense(
        v_uid, p_group_id, p_paid_by, p_amount, p_description, p_category, p_split_type,
        v_splits, now(), v_currency, v_effective_rate
      );
    else
      perform public._insert_contact_expense(
        v_uid, p_contact_id, p_paid_by, p_amount, p_description, p_category, p_split_type,
        v_splits, now(), v_currency, v_effective_rate
      );
    end if;
    raise exception 'trial run complete' using errcode = 'EVNTR';
  exception when sqlstate 'EVNTR' then
    null;
  end;

  insert into public.recurring_schedules (
    kind, group_id, user_lo, user_hi, created_by, paid_by, description, category, amount,
    currency, last_exchange_rate, split_type, splits, start_date, tz, frequency, end_date, max_count
  )
  values (
    case when p_group_id is not null then 'group' else 'contact' end,
    p_group_id, v_lo, v_hi, v_uid, p_paid_by, btrim(p_description), p_category, round(p_amount, 2),
    v_currency, v_rate, p_split_type, v_norm, p_start_date, p_tz, p_frequency, p_end_date, p_max_count
  )
  returning id into v_id;

  perform public._materialise_one(v_id, now() + interval '48 hours');

  select * into v_schedule from public.recurring_schedules where id = v_id;
  return v_schedule;
end;
$$;

-- Stops a repeating expense. A caller who is not a member of the group (or one
-- of the two contacts) gets the same 'Schedule not found' as for a missing id,
-- so the id's existence is not revealed; that check runs before the row is
-- locked. Any member of the group (or either contact) may
-- stop it, not only its creator or payer, so a split-only member can clear the
-- leave_group refusal. Marks it stopped and deletes the occurrences that are
-- still ahead (date in the future) and untouched by hand; past occurrences and
-- hand-edited ones stay. Stopping a stopped schedule changes nothing. The row
-- is locked first so this serialises with the engine.
create or replace function public.stop_recurring_schedule(p_schedule_id uuid)
returns public.recurring_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_schedule public.recurring_schedules;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_schedule from public.recurring_schedules where id = p_schedule_id;

  if not found then
    raise exception 'Schedule not found';
  end if;

  if v_schedule.kind = 'group' then
    if not public.is_group_member(v_schedule.group_id, v_uid) then
      raise exception 'Schedule not found';
    end if;
  elsif v_uid <> v_schedule.user_lo and v_uid <> v_schedule.user_hi then
    raise exception 'Schedule not found';
  end if;

  select * into v_schedule
  from public.recurring_schedules
  where id = p_schedule_id
  for update;

  if not found then
    raise exception 'Schedule not found';
  end if;

  if v_schedule.stopped_at is not null then
    return v_schedule;
  end if;

  update public.recurring_schedules
  set stopped_at = now(), stop_reason = 'stopped'
  where id = p_schedule_id
  returning * into v_schedule;

  delete from public.expenses
  where schedule_id = p_schedule_id and date > now() and not hand_edited;

  delete from public.contact_expenses
  where schedule_id = p_schedule_id and date > now() and not hand_edited;

  return v_schedule;
end;
$$;

-- Edits a recurring schedule. Null keeps a value; the p_clear_* flags remove a
-- limit. Frequency, start date, currency and exchange rate cannot be edited
-- (occurrence dates depend on them): stop the schedule and create a new one.
-- Amount and splits change together or not at all; description, category, split
-- type, payer and the limits change on their own.
--
-- Only the future changes. A pending occurrence is a row of the schedule with
-- date > now() that nobody edited by hand (hand_edited = false); a row dated
-- exactly now() is not pending (the balance predicate is date <= now()). Edits
-- rewrite the pending rows through the private update helpers with
-- p_mark_hand_edited = false, so they stay rewritable by the next edit; past
-- rows and hand-edited rows are never touched.
--
-- Rewritten rows are not repriced: each keeps its own exchange_rate (the rate
-- it was created at) and its base amounts are recomputed at that rate when the
-- amount changes. Only occurrences the engine creates later use the schedule's
-- current rate (last_exchange_rate). The stored payload's splits are normalised
-- to [{userId (lowercase uuid text), amount, baseAmount}], nothing else, with
-- baseAmount at the current rate: that is the payload for the next occurrences
-- (the engine recomputes it anyway).
--
-- A finished schedule (stop_reason 'completed': max_count or end_date reached)
-- can still have its pending rows rewritten, but its limits cannot be changed.
-- A schedule stopped by a member, because someone left, or as invalid cannot be
-- edited at all.
--
-- Limits: lowering end_date or max_count deletes the pending, non-hand-edited
-- rows beyond the new limit; a hand-edited pending row stays and counts at its
-- date. The cursor (next_index) is never moved, so deleted rows are not
-- recreated if the limit is raised again. A max_count at or below the number of
-- occurrences already made (created or skipped), or an end_date before the next
-- occurrence, completes the schedule ('completed'). The engine then runs once
-- (the same function cron uses, 48 hours ahead) so the series is consistent:
-- it creates anything now due and applies completion.
--
-- The schedule row is locked first (select ... for update), which serialises
-- this against cron, the app-open catch-up and stop; it is taken only after the
-- caller is known to be a member (a non-member and a missing id get the same
-- 'Schedule not found' and block nothing) and the stopped state is checked
-- again under it. Everything is one
-- transaction: any failure rolls back the edit, the deletions and the rewrites.
create or replace function public.update_recurring_schedule(
  p_schedule_id uuid,
  p_amount numeric default null,
  p_description text default null,
  p_category text default null,
  p_split_type public.split_type default null,
  p_splits jsonb default null,
  p_paid_by uuid default null,
  p_end_date date default null,
  p_max_count int default null,
  p_clear_end_date boolean default false,
  p_clear_max_count boolean default false
)
returns public.recurring_schedules
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_s public.recurring_schedules;
  v_member boolean;
  v_base text;
  v_other uuid;
  v_paid_by uuid;
  v_amount numeric(12, 2);
  v_description text;
  v_category text;
  v_split_type public.split_type;
  v_end date;
  v_max int;
  v_rate numeric;
  v_input jsonb;
  v_stored jsonb;
  v_split jsonb;
  v_split_user uuid;
  v_split_amount numeric(12, 2);
  v_split_raw numeric;
  v_split_total numeric(12, 2) := 0;
  v_clean jsonb := '[]'::jsonb;
  v_row_splits jsonb;
  v_seen uuid[] := '{}';
  v_first_beyond date;
  v_row record;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select * into v_s from public.recurring_schedules where id = p_schedule_id;
  if found then
    v_member := coalesce(
      case when v_s.kind = 'group'
        then public.is_group_member(v_s.group_id, v_uid)
        else v_uid in (v_s.user_lo, v_s.user_hi)
      end,
      false
    );
  end if;
  if not found or not v_member then
    raise exception 'Schedule not found';
  end if;

  select * into v_s from public.recurring_schedules where id = p_schedule_id for update;
  if not found then
    raise exception 'Schedule not found';
  end if;

  if v_s.stopped_at is not null then
    if v_s.stop_reason is distinct from 'completed' then
      raise exception 'This repeating item has stopped and can no longer be edited';
    end if;
    if p_end_date is not null or p_max_count is not null
      or coalesce(p_clear_end_date, false) or coalesce(p_clear_max_count, false) then
      raise exception 'This repeating item has finished, so its limits cannot be changed';
    end if;
  end if;

  if (p_amount is null) <> (p_splits is null) then
    raise exception 'Amount and splits must be changed together';
  end if;
  if p_amount = 'NaN'::numeric or p_amount in ('Infinity'::numeric, '-Infinity'::numeric) then
    raise exception 'Expense amount must be a valid number';
  end if;
  if coalesce(p_clear_end_date, false) and p_end_date is not null then
    raise exception 'Choose either a new end date or clear it, not both';
  end if;
  if coalesce(p_clear_max_count, false) and p_max_count is not null then
    raise exception 'Choose either a new number of occurrences or clear it, not both';
  end if;
  if p_description is not null and btrim(p_description) = '' then
    raise exception 'Expense description is required';
  end if;
  if p_max_count is not null and p_max_count < 1 then
    raise exception 'The number of occurrences must be at least 1';
  end if;

  v_paid_by := coalesce(p_paid_by, v_s.paid_by);
  v_amount := coalesce(round(p_amount, 2), v_s.amount);
  v_description := coalesce(btrim(p_description), v_s.description);
  v_category := coalesce(p_category, v_s.category);
  v_split_type := coalesce(p_split_type, v_s.split_type);
  v_end := case when coalesce(p_clear_end_date, false) then null else coalesce(p_end_date, v_s.end_date) end;
  v_max := case when coalesce(p_clear_max_count, false) then null else coalesce(p_max_count, v_s.max_count) end;

  if v_amount <= 0 then
    raise exception 'Expense amount must be greater than zero';
  end if;
  if v_end is not null and v_end < v_s.start_date then
    raise exception 'The end date cannot be before the start date';
  end if;

  if v_s.kind = 'group' then
    select g.currency into v_base from public.groups g where g.id = v_s.group_id;
    if not public.is_group_member(v_s.group_id, v_paid_by) then
      raise exception 'Expense payer must be a group member';
    end if;
  else
    v_other := case when v_uid = v_s.user_lo then v_s.user_hi else v_s.user_lo end;
    if not exists (
      select 1 from public.contacts c where c.owner_id = v_uid and c.contact_user_id = v_other
    ) then
      raise exception 'You can only edit repeating items with accepted contacts';
    end if;
    select s.currency into v_base from public.contact_pair_settings s
    where s.user_lo = v_s.user_lo and s.user_hi = v_s.user_hi;
    v_base := coalesce(v_base, 'USD');
    if v_paid_by <> v_s.user_lo and v_paid_by <> v_s.user_hi then
      raise exception 'Expense payer must be a participant';
    end if;
  end if;

  -- The splits that will be stored (the new ones, or the existing ones when
  -- only other fields change) must all still belong to the group or pair.
  v_input := coalesce(p_splits, v_s.splits);
  if jsonb_typeof(v_input) <> 'array' or jsonb_array_length(v_input) = 0 then
    raise exception 'At least one split is required';
  end if;
  for v_split in select value from jsonb_array_elements(v_input)
  loop
    v_split_user := (v_split->>'userId')::uuid;
    v_split_raw := (v_split->>'amount')::numeric;
    if v_split_user is null or v_split_raw is null then
      raise exception 'Every split needs a user and an amount';
    end if;
    if v_split_raw = 'NaN'::numeric or v_split_raw in ('Infinity'::numeric, '-Infinity'::numeric) then
      raise exception 'Split amount must be a valid number';
    end if;
    v_split_amount := round(v_split_raw, 2);
    if v_split_amount < 0 then
      raise exception 'Split amount cannot be negative';
    end if;
    if v_split_user = any (v_seen) then
      raise exception 'Each split user can appear only once';
    end if;
    v_seen := v_seen || v_split_user;
    if v_s.kind = 'group' then
      if not public.is_group_member(v_s.group_id, v_split_user) then
        raise exception 'Every split user must be a group member';
      end if;
    elsif v_split_user <> v_s.user_lo and v_split_user <> v_s.user_hi then
      raise exception 'Every split user must be a participant';
    end if;
    v_split_total := v_split_total + v_split_amount;
    v_clean := v_clean || jsonb_build_array(
      jsonb_build_object('userId', lower(v_split_user::text), 'amount', v_split_amount)
    );
  end loop;
  -- A schedule that includes a deleted user would only be stopped by the engine.
  if exists (
    select 1 from public.profiles p
    where p.deleted_at is not null
      and (p.id = v_paid_by or p.id = any (v_seen) or p.id in (v_s.user_lo, v_s.user_hi))
  ) then
    raise exception 'Deleted users cannot be added to new expenses';
  end if;
  if v_split_total <> v_amount then
    raise exception 'Split amounts must add up to the expense total';
  end if;

  if upper(btrim(v_s.currency)) = upper(btrim(v_base)) then
    v_rate := 1;
  else
    v_rate := public._schedule_rate(v_s);
  end if;
  v_stored := public._convert_splits_to_base(v_clean, v_rate, round(v_amount * v_rate, 2));

  update public.recurring_schedules
  set
    paid_by = v_paid_by,
    amount = v_amount,
    description = v_description,
    category = v_category,
    split_type = v_split_type,
    splits = v_stored,
    end_date = v_end,
    max_count = v_max
  where id = v_s.id;

  -- Pending rows beyond a changed limit go. Occurrence dates only grow with the
  -- index, so "index >= max_count" is "date >= the date of occurrence max_count";
  -- that date is only computed when rows past it can exist.
  if p_end_date is not null or p_max_count is not null
    or coalesce(p_clear_end_date, false) or coalesce(p_clear_max_count, false) then
    v_first_beyond := case
      when v_max is not null and v_max < v_s.next_index
        then public._occurrence_date(v_s.start_date, v_s.frequency, v_max)
    end;
    if v_s.kind = 'group' then
      delete from public.expenses e
      where e.schedule_id = v_s.id and e.date > now() and not e.hand_edited
        and ((v_end is not null and e.occurrence_date > v_end)
          or (v_first_beyond is not null and e.occurrence_date >= v_first_beyond));
    else
      delete from public.contact_expenses e
      where e.schedule_id = v_s.id and e.date > now() and not e.hand_edited
        and ((v_end is not null and e.occurrence_date > v_end)
          or (v_first_beyond is not null and e.occurrence_date >= v_first_beyond));
    end if;
  end if;

  if p_amount is not null or p_description is not null or p_category is not null
    or p_split_type is not null or p_paid_by is not null then
    if v_s.kind = 'group' then
      for v_row in
        select e.id, e.currency, e.exchange_rate from public.expenses e
        where e.schedule_id = v_s.id and e.date > now() and not e.hand_edited
        order by e.occurrence_date
        for update
      loop
        v_row_splits := public._convert_splits_to_base(
          v_clean, v_row.exchange_rate, round(v_amount * v_row.exchange_rate, 2)
        );
        perform public._update_group_expense(
          v_uid, v_row.id, v_paid_by, v_amount, v_description, v_category, v_split_type,
          v_row_splits, null, v_row.currency, v_row.exchange_rate, false
        );
      end loop;
    else
      for v_row in
        select e.id, e.currency, e.exchange_rate from public.contact_expenses e
        where e.schedule_id = v_s.id and e.date > now() and not e.hand_edited
        order by e.occurrence_date
        for update
      loop
        v_row_splits := public._convert_splits_to_base(
          v_clean, v_row.exchange_rate, round(v_amount * v_row.exchange_rate, 2)
        );
        perform public._update_contact_expense(
          v_uid, v_row.id, v_paid_by, v_amount, v_description, v_category, v_split_type,
          v_row_splits, null, v_row.currency, v_row.exchange_rate, false
        );
      end loop;
    end if;
  end if;

  perform public._materialise_one(v_s.id, now() + interval '48 hours');

  select * into v_s from public.recurring_schedules where id = p_schedule_id;
  return v_s;
end;
$$;

revoke execute on function public.update_recurring_schedule(uuid, numeric, text, text, public.split_type, jsonb, uuid, date, int, boolean, boolean)
  from public, anon;
grant execute on function public.update_recurring_schedule(uuid, numeric, text, text, public.split_type, jsonb, uuid, date, int, boolean, boolean)
  to authenticated;

-- Internal: stops a schedule because a member left (the engine's 'member left'
-- stop, shared with account deletion). Already stopped: nothing. It does not
-- delete the schedule's pending rows; the caller decides. Not callable by clients.
create or replace function public._stop_schedule_member_left(p_schedule_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.recurring_schedules
  set stopped_at = now(), stop_reason = 'member left',
    last_error = 'This repeating item was stopped.'
  where id = p_schedule_id and stopped_at is null;
$$;

revoke execute on function public._stop_schedule_member_left(uuid)
  from public, anon, authenticated;

-- Internal: the one-on-one balance between p_user_id and p_other_id from
-- p_user_id's side, the same arithmetic as get_contact_balance (base amounts, rows
-- dated in the future not yet counted) but for a given user rather than whoever is
-- signed in, so account deletion can ask it with no JWT. Not callable by clients.
create or replace function public._contact_pair_balance(p_user_id uuid, p_other_id uuid)
returns numeric
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select case
    when p_user_id is null or p_other_id is null or p_user_id = p_other_id then 0
    else coalesce((
      select sum(
        case
          when ce.paid_by = p_user_id and ces.user_id = p_other_id then ces.base_amount
          when ce.paid_by = p_other_id and ces.user_id = p_user_id then -ces.base_amount
          else 0
        end
      )
      from public.contact_expenses ce
      join public.contact_expense_splits ces on ces.expense_id = ce.id
      where ce.user_lo = least(p_user_id, p_other_id)
        and ce.user_hi = greatest(p_user_id, p_other_id)
        and ce.date <= now()
    ), 0) + coalesce((
      select sum(
        case
          when cp.paid_by = p_user_id and cp.paid_to = p_other_id then cp.base_amount
          when cp.paid_by = p_other_id and cp.paid_to = p_user_id then -cp.base_amount
          else 0
        end
      )
      from public.contact_payments cp
      where cp.user_lo = least(p_user_id, p_other_id)
        and cp.user_hi = greatest(p_user_id, p_other_id)
        and cp.date <= now()
    ), 0)
  end;
$$;

revoke execute on function public._contact_pair_balance(uuid, uuid)
  from public, anon, authenticated;

-- Internal: the raw pairwise "who owes whom" edges of a group, the arithmetic of
-- get_group_pairwise_balances (base amounts, settle-up payments, rows dated in the
-- future not yet counted, an edge only when the net of a pair exceeds half a cent)
-- without its auth.uid() gate and without names. _account_leave_group uses it to
-- tell whether a member with a zero net balance still has an open edge. Not callable
-- by clients.
create or replace function public._group_pairwise_balances(p_group_id uuid)
returns table (
  from_user uuid,
  to_user uuid,
  amount numeric(12, 2)
)
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  with raw_debts as (
    select es.user_id as dr, e.paid_by as cr, es.base_amount as amt
    from public.expenses e
    join public.expense_splits es on es.expense_id = e.id
    where e.group_id = p_group_id and es.user_id <> e.paid_by and e.date <= now()
    union all
    select pmt.paid_to as dr, pmt.paid_by as cr, pmt.base_amount as amt
    from public.payments pmt
    where pmt.group_id = p_group_id and pmt.date <= now()
  ),
  pair_net as (
    select
      least(rd.dr, rd.cr) as u_lo,
      greatest(rd.dr, rd.cr) as u_hi,
      sum(case when rd.dr < rd.cr then rd.amt else -rd.amt end) as net_lo
    from raw_debts rd
    group by 1, 2
  )
  select
    case when pn.net_lo > 0 then pn.u_lo else pn.u_hi end,
    case when pn.net_lo > 0 then pn.u_hi else pn.u_lo end,
    round(abs(pn.net_lo), 2)::numeric(12, 2)
  from pair_net pn
  where abs(pn.net_lo) > 0.005;
$$;

revoke execute on function public._group_pairwise_balances(uuid)
  from public, anon, authenticated;

-- Deletes the signed-in user's account, in one transaction (any error rolls all of
-- it back). Open debts never block it. What stays is what other people's balances
-- are made of: the expense, split and payment rows the user took part in, shown
-- under the tombstone profile ('Deleted user', no avatar, deleted_at set).
--   1. The profile row is locked (FOR NO KEY UPDATE: two calls serialise, but a
--      concurrent expense insert that only needs a key-share lock on it is not
--      blocked). Already a tombstone (or no profile) AND no auth.users row left:
--      return, nothing changes. A tombstone whose auth user is still there (marked by
--      hand) is not an early return: the steps below are idempotent and delete it.
--   2. A live profile becomes a tombstone first, so nothing new can name it. (A
--      tombstone cannot be updated again: see _reject_deleted_profile_update.)
--   3. Every running schedule where they are the payer, in the splits, the
--      creator, or one of the two contacts is stopped as 'member left'. Rows
--      dated in the future are removed: every expense and payment (group and
--      contact, whatever created it) where they pay, are paid, or have a split above
--      zero (the rule of get_upcoming_expenses and leave_group), and the pending,
--      not hand-edited rows of the stopped schedules (as stop_recurring_schedule
--      does). They are not in anyone's balance yet. Past rows are never removed.
--   4. Each group they are in goes through _account_leave_group.
--   5. Contacts: their contact_requests (both directions) are deleted. For each
--      pair with a contacts row: a zero balance (abs < 0.01) deletes both rows, an
--      open balance deletes only theirs so the other person keeps the contact and
--      the ledger. contact_pair_settings go only when the pair has no expense or
--      payment left (a retained ledger keeps its currency). Contact expenses,
--      payments and splits are always kept.
--   6. The auth.users row is deleted (email, password hash, and on a real project
--      the sessions, identities and refresh tokens that cascade from it).
--   7. Best effort: GoTrue's auth.audit_log_entries keeps the email, IP and actor id of
--      past sign-ins, so the rows naming this user are deleted when that table exists.
--      A refusal there (privileges, a different GoTrue version) is a NOTICE and does
--      not roll the deletion back.
-- The AFTER DELETE trigger from step 6 finds the tombstone already there.
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted timestamptz;
  v_has_profile boolean;
  v_schedule uuid;
  v_stopped uuid[] := '{}';
  v_group uuid;
  v_other uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select p.deleted_at into v_deleted
  from public.profiles p where p.id = v_uid for no key update;
  v_has_profile := found;
  if (not v_has_profile or v_deleted is not null)
    and not exists (select 1 from auth.users au where au.id = v_uid) then
    return;
  end if;

  if v_has_profile and v_deleted is null then
    update public.profiles
    set deleted_at = now(), full_name = 'Deleted user', avatar_url = null
    where id = v_uid;
  end if;

  for v_schedule in
    select s.id
    from public.recurring_schedules s
    where s.stopped_at is null
      and (
        s.paid_by = v_uid
        or s.created_by = v_uid
        or v_uid in (s.user_lo, s.user_hi)
        or exists (
          select 1 from jsonb_array_elements(s.splits) sp
          where lower(sp->>'userId') = v_uid::text
        )
      )
    order by s.id
    for update of s
  loop
    perform public._stop_schedule_member_left(v_schedule);
    v_stopped := v_stopped || v_schedule;
  end loop;

  delete from public.expenses
  where schedule_id = any (v_stopped) and date > now() and not hand_edited;

  delete from public.contact_expenses
  where schedule_id = any (v_stopped) and date > now() and not hand_edited;

  delete from public.expenses e
  where e.date > now()
    and (
      e.paid_by = v_uid
      or exists (
        select 1 from public.expense_splits es
        where es.expense_id = e.id and es.user_id = v_uid and es.amount > 0
      )
    );

  delete from public.payments
  where date > now() and v_uid in (paid_by, paid_to);

  delete from public.contact_expenses ce
  where ce.date > now()
    and (
      ce.paid_by = v_uid
      or exists (
        select 1 from public.contact_expense_splits ces
        where ces.expense_id = ce.id and ces.user_id = v_uid and ces.amount > 0
      )
    );

  delete from public.contact_payments
  where date > now() and v_uid in (paid_by, paid_to);

  for v_group in
    select gm.group_id from public.group_members gm
    where gm.user_id = v_uid
    order by gm.group_id
  loop
    perform public._account_leave_group(v_uid, v_group);
  end loop;

  delete from public.contact_requests
  where requester_id = v_uid or recipient_id = v_uid;

  for v_other in
    select c.contact_user_id from public.contacts c where c.owner_id = v_uid
    union
    select c.owner_id from public.contacts c where c.contact_user_id = v_uid
  loop
    if abs(public._contact_pair_balance(v_uid, v_other)) < 0.01 then
      delete from public.contacts
      where (owner_id = v_uid and contact_user_id = v_other)
        or (owner_id = v_other and contact_user_id = v_uid);
    else
      delete from public.contacts
      where owner_id = v_uid and contact_user_id = v_other;
    end if;
  end loop;

  delete from public.contact_pair_settings s
  where v_uid in (s.user_lo, s.user_hi)
    and not exists (
      select 1 from public.contact_expenses ce
      where ce.user_lo = s.user_lo and ce.user_hi = s.user_hi
    )
    and not exists (
      select 1 from public.contact_payments cp
      where cp.user_lo = s.user_lo and cp.user_hi = s.user_hi
    );

  delete from auth.users where id = v_uid;

  if to_regclass('auth.audit_log_entries') is not null then
    begin
      delete from auth.audit_log_entries
      where payload->>'actor_id' = v_uid::text
        or payload->'traits'->>'user_id' = v_uid::text;
    exception when others then
      raise notice 'could not clear the audit log entries of the deleted account: %', sqlstate;
    end;
  end if;
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Trigger function for on_auth_user_deleted (the trigger itself lives on auth.users
-- and is created in a migration, see the note at the top of this file). A raw
-- delete of an auth user (dashboard, SQL) leaves the profile as a tombstone. It
-- does only that: no group or contact clean-up, memberships stay as they are. It
-- never raises (an error becomes a NOTICE) and does nothing to a profile that is
-- already a tombstone or missing.
create or replace function public._tombstone_deleted_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    update public.profiles
    set deleted_at = now(), full_name = 'Deleted user', avatar_url = null
    where id = old.id and deleted_at is null;
  exception when others then
    raise notice 'could not tombstone the profile of deleted auth user %: %', old.id, sqlerrm;
  end;
  return old;
end;
$$;

revoke execute on function public._tombstone_deleted_auth_user()
  from public, anon, authenticated;

-- A tombstone is final. Without this, a deleted user's still-valid JWT (about an
-- hour) could call update_profile and put the name and avatar back. The delete
-- function's own update runs on a live row (OLD.deleted_at is null) and so does the
-- raw-delete trigger's, so neither is blocked. Not callable by clients.
create or replace function public._reject_deleted_profile_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.deleted_at is not null then
    raise exception 'Deleted accounts cannot be changed';
  end if;
  return new;
end;
$$;

revoke execute on function public._reject_deleted_profile_update()
  from public, anon, authenticated;

create trigger profiles_reject_deleted_update
  before update on public.profiles
  for each row execute function public._reject_deleted_profile_update();

-- PostgREST pre-request guard: a deleted account's JWT stays valid until it expires
-- (about an hour), and during that time it could still create a group or send a
-- contact request. With `pgrst.db_pre_request = 'public.reject_deleted_caller'` set on
-- the authenticator role, PostgREST runs this before every request, as the request
-- role (so anon, authenticated and service_role keep EXECUTE; it is deliberately not
-- named with a leading underscore). It raises 42501 for a caller whose profile is a
-- tombstone and returns for everyone else. It is a guard, not a gate: it never raises
-- for any other reason (a malformed uid claim or a failed lookup lets the request
-- through), and it is one primary-key lookup. The setting is made by the migration;
-- on a hosted project it may need to be applied by hand (see the migration).
create or replace function public.reject_deleted_caller()
returns void
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_uid uuid;
  v_deleted boolean := false;
begin
  begin
    v_uid := auth.uid();
    if v_uid is null then
      return;
    end if;
    select true into v_deleted
    from public.profiles p
    where p.id = v_uid and p.deleted_at is not null;
  exception when others then
    return;
  end;

  if coalesce(v_deleted, false) then
    raise exception 'This account has been deleted' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.reject_deleted_caller() from public;
grant execute on function public.reject_deleted_caller() to anon, authenticated, service_role;
