-- Account deletion, piece 3: public.delete_my_account() and the raw-delete trigger.
--
-- delete_my_account tombstones the caller's profile, stops the schedules that
-- involve them, removes future-dated rows that involve them, takes them out of
-- every group (_account_leave_group), cleans up contacts and deletes their
-- auth.users row, all in one transaction. _stop_schedule_member_left is the
-- engine's 'member left' stop, now shared: _materialise_recurring calls it instead
-- of repeating the update. on_auth_user_deleted makes a raw delete of an auth user
-- (dashboard, SQL) leave a tombstone profile; it does no group or contact
-- clean-up. The trigger is here and not in schemas/ for the reason in the note at
-- the top of schemas/04_functions.sql.
--
-- Also here: a BEFORE UPDATE trigger that makes a tombstone final, the PostgREST
-- pre-request guard reject_deleted_caller() (and the role setting that turns it
-- on), a best-effort audit-log cleanup in delete_my_account, and _account_leave_group
-- replaced so that a net-zero member with an open pairwise edge stays as a ghost.

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

-- _account_leave_group, replaced (it was created in the previous migration, #27):
-- in a group with simplify_debts off, a member whose net balance is zero but who
-- still has an open pairwise edge now stays as a ghost, because create_payment
-- refuses a payment with a non-member and the edge could never be settled.
-- Same signature and ACL.
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

-- Point PostgREST at the guard. Setting a role parameter needs rights that a hosted
-- project's migration role may not have, and the role does not exist where there is
-- no PostgREST, so this never fails the migration: it raises a NOTICE instead.
-- If the NOTICE "db_pre_request not set" appears, apply it by hand as a superuser
-- (the SQL editor on a hosted project):
--   alter role authenticator set pgrst.db_pre_request = 'public.reject_deleted_caller';
--   notify pgrst, 'reload config';
-- Until it is set, a deleted account's JWT can still call RPCs for up to an hour
-- (update_profile stays refused by the trigger above either way). It is not set for
-- anon: the guard does nothing without a uid.
do $pre$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticator') then
    begin
      alter role authenticator set pgrst.db_pre_request = 'public.reject_deleted_caller';
      notify pgrst, 'reload config';
    exception when others then
      raise notice 'db_pre_request not set: %', sqlstate;
    end;
  end if;
end
$pre$;

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public._tombstone_deleted_auth_user();
