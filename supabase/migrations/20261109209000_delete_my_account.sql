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

-- Deletes the signed-in user's account, in one transaction (any error rolls all of
-- it back). Open debts never block it. What stays is what other people's balances
-- are made of: the expense, split and payment rows the user took part in, shown
-- under the tombstone profile ('Deleted user', no avatar, deleted_at set).
--   1. The profile row is locked, so two calls serialise. Already a tombstone (or
--      no profile): return, nothing changes.
--   2. The profile becomes a tombstone first, so nothing new can name it.
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
  v_schedule uuid;
  v_stopped uuid[] := '{}';
  v_group uuid;
  v_other uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  select p.deleted_at into v_deleted
  from public.profiles p where p.id = v_uid for update;
  if not found or v_deleted is not null then
    return;
  end if;

  update public.profiles
  set deleted_at = now(), full_name = 'Deleted user', avatar_url = null
  where id = v_uid;

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

drop trigger if exists on_auth_user_deleted on auth.users;
create trigger on_auth_user_deleted
  after delete on auth.users
  for each row execute function public._tombstone_deleted_auth_user();
