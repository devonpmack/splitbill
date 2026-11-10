-- Admin-only account deletion: one code path for both routes.
--
-- The whole body of delete_my_account() moves, unchanged in what it does, into the
-- private _delete_account(uuid) (which takes the user as an argument and never looks at
-- auth.uid()). delete_my_account() becomes a thin wrapper (same signature, same ACL,
-- same 'Not authenticated'), and admin_delete_account(uuid) is the same call for an
-- operator who got an emailed request: service_role only, one line of counts back.
-- Why it exists: deleting a user by hand in the dashboard only runs the
-- on_auth_user_deleted trigger (it tombstones the name, picture and login) and skips
-- everything else delete_my_account does. Migrations 20261109209000 and earlier are
-- already applied and are not edited; this one replaces delete_my_account.

-- Deletes one account, in one transaction (any error rolls all of it back), and says
-- whether it did anything. This is the whole of account deletion: delete_my_account()
-- (the signed-in user) and admin_delete_account() (an operator, for an emailed
-- request) both call it, so the two routes cannot drift apart. Private, and it never
-- looks at auth.uid(): the user is the argument. Open debts never block it. What stays
-- is what other people's balances are made of: the expense, split and payment rows the
-- user took part in, shown under the tombstone profile ('Deleted user', no avatar,
-- deleted_at set).
--   1. The profile row is locked (FOR NO KEY UPDATE: two calls serialise, but a
--      concurrent expense insert that only needs a key-share lock on it is not
--      blocked). Already a tombstone (or no profile) AND no auth.users row left:
--      return false, nothing changes. A tombstone whose auth user is still there
--      (marked by hand) is not an early return: the steps below are idempotent and
--      delete it. So are a profile with no auth user and an auth user with no profile.
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
--
-- It counts what it does as it goes (ROW_COUNT of each statement, and one group,
-- schedule or pair at a time) and leaves the counts, and nothing else, in the
-- transaction-local setting app.delete_account_stats as json, for
-- admin_delete_account to word. Counting the deletions where they happen means the
-- summary cannot disagree with them and no deletion rule is written twice. The
-- setting lives and dies with the transaction. Counts only: no id, name or email.
create or replace function public._delete_account(p_uid uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := p_uid;
  v_deleted timestamptz;
  v_has_profile boolean;
  v_schedule uuid;
  v_stopped uuid[] := '{}';
  v_group uuid;
  v_other uuid;
  v_n bigint;
  v_profile text := 'none';
  v_auth_removed bigint := 0;
  v_groups_total int := 0;
  v_groups_left int := 0;
  v_groups_deleted int := 0;
  v_future_rows bigint := 0;
  v_requests bigint := 0;
  v_pairs_total int := 0;
  v_pairs_removed int := 0;
  v_audit_removed bigint := 0;
  v_audit_state text := 'no table';
begin
  if v_uid is null then
    return false;
  end if;

  select p.deleted_at into v_deleted
  from public.profiles p where p.id = v_uid for no key update;
  v_has_profile := found;
  if (not v_has_profile or v_deleted is not null)
    and not exists (select 1 from auth.users au where au.id = v_uid) then
    return false;
  end if;

  if v_has_profile and v_deleted is null then
    update public.profiles
    set deleted_at = now(), full_name = 'Deleted user', avatar_url = null
    where id = v_uid;
    v_profile := 'tombstoned';
  elsif v_has_profile then
    v_profile := 'already';
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
  get diagnostics v_n = row_count;
  v_future_rows := v_future_rows + v_n;

  delete from public.contact_expenses
  where schedule_id = any (v_stopped) and date > now() and not hand_edited;
  get diagnostics v_n = row_count;
  v_future_rows := v_future_rows + v_n;

  delete from public.expenses e
  where e.date > now()
    and (
      e.paid_by = v_uid
      or exists (
        select 1 from public.expense_splits es
        where es.expense_id = e.id and es.user_id = v_uid and es.amount > 0
      )
    );
  get diagnostics v_n = row_count;
  v_future_rows := v_future_rows + v_n;

  delete from public.payments
  where date > now() and v_uid in (paid_by, paid_to);
  get diagnostics v_n = row_count;
  v_future_rows := v_future_rows + v_n;

  delete from public.contact_expenses ce
  where ce.date > now()
    and (
      ce.paid_by = v_uid
      or exists (
        select 1 from public.contact_expense_splits ces
        where ces.expense_id = ce.id and ces.user_id = v_uid and ces.amount > 0
      )
    );
  get diagnostics v_n = row_count;
  v_future_rows := v_future_rows + v_n;

  delete from public.contact_payments
  where date > now() and v_uid in (paid_by, paid_to);
  get diagnostics v_n = row_count;
  v_future_rows := v_future_rows + v_n;

  for v_group in
    select gm.group_id from public.group_members gm
    where gm.user_id = v_uid
    order by gm.group_id
  loop
    perform public._account_leave_group(v_uid, v_group);
    v_groups_total := v_groups_total + 1;
    if not exists (
      select 1 from public.group_members gm
      where gm.group_id = v_group and gm.user_id = v_uid
    ) then
      v_groups_left := v_groups_left + 1;
    end if;
    if not exists (select 1 from public.groups g where g.id = v_group) then
      v_groups_deleted := v_groups_deleted + 1;
    end if;
  end loop;

  delete from public.contact_requests
  where requester_id = v_uid or recipient_id = v_uid;
  get diagnostics v_requests = row_count;

  for v_other in
    select c.contact_user_id from public.contacts c where c.owner_id = v_uid
    union
    select c.owner_id from public.contacts c where c.contact_user_id = v_uid
  loop
    v_pairs_total := v_pairs_total + 1;
    if abs(public._contact_pair_balance(v_uid, v_other)) < 0.01 then
      delete from public.contacts
      where (owner_id = v_uid and contact_user_id = v_other)
        or (owner_id = v_other and contact_user_id = v_uid);
      v_pairs_removed := v_pairs_removed + 1;
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
  get diagnostics v_auth_removed = row_count;

  if to_regclass('auth.audit_log_entries') is not null then
    begin
      delete from auth.audit_log_entries
      where payload->>'actor_id' = v_uid::text
        or payload->'traits'->>'user_id' = v_uid::text;
      get diagnostics v_audit_removed = row_count;
      v_audit_state := 'ok';
    exception when others then
      v_audit_state := 'refused';
      raise notice 'could not clear the audit log entries of the deleted account: %', sqlstate;
    end;
  end if;

  perform set_config(
    'app.delete_account_stats',
    jsonb_build_object(
      'profile', v_profile,
      'auth_removed', v_auth_removed,
      'groups_total', v_groups_total,
      'groups_left', v_groups_left,
      'groups_deleted', v_groups_deleted,
      'schedules_stopped', coalesce(cardinality(v_stopped), 0),
      'future_rows_removed', v_future_rows,
      'requests_removed', v_requests,
      'pairs_total', v_pairs_total,
      'pairs_removed', v_pairs_removed,
      'audit_removed', v_audit_removed,
      'audit_state', v_audit_state
    )::text,
    true
  );

  return true;
end;
$$;

revoke execute on function public._delete_account(uuid)
  from public, anon, authenticated;

-- Deletes the signed-in user's account: all of it is _delete_account, which this
-- only points at the caller. Open debts never block it. Contract: no arguments,
-- returns void, authenticated only. Raises 'Not authenticated' when there is no
-- signed-in user.
create or replace function public.delete_my_account()
returns void
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

  perform public._delete_account(v_uid);
end;
$$;

revoke execute on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- Deletes the account of the user with this id, for an operator who got an emailed
-- request: run it in the SQL editor, once, as `select public.admin_delete_account('<id>'::uuid);`.
-- Same code path as delete_my_account (_delete_account), so the two promises are the
-- same: the profile becomes 'Deleted user', schedules are stopped, future rows,
-- contact requests and settled contacts are removed, groups are left, the login and
-- its audit-log rows are deleted; what other people's balances are made of stays.
-- Returns one line of counts, never a name, an email or an id:
--   deleted: profile tombstoned; auth user removed; groups left 2 of 3 (1 deleted); schedules stopped 1; future rows removed 3; contact requests removed 1; contacts removed 2 of 3 pairs; audit rows removed 4
-- 'profile' says tombstoned, was already a tombstone, or no profile; 'auth user' says
-- removed or no auth user; 'groups left x of y' counts the groups the user belonged
-- to, the rest stay as a ghost; 'contacts removed x of y pairs' counts the contacts,
-- the rest stay for the other person because of an open balance; the audit part says
-- (cleanup refused) or (no audit table) when it could not run. When there was nothing
-- to do (unknown id, or already deleted and no login left) it changes nothing and
-- returns: nothing to delete (already deleted or unknown id).
-- A null id raises 'User id is required'. Deliberately not underscore-named: it is
-- meant to be called, and only by service_role (the SQL editor's role and server
-- code): EXECUTE is revoked from PUBLIC, anon and authenticated, so no signed-in
-- user can reach it, not even for their own id (they use delete_my_account). This
-- is the one function outside the `_` rule that clients must not execute; the
-- migration checks and tests/sql-security.test.ts list it by name.
create or replace function public.admin_delete_account(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_stats jsonb;
begin
  if p_user_id is null then
    raise exception 'User id is required';
  end if;

  if not public._delete_account(p_user_id) then
    return 'nothing to delete (already deleted or unknown id)';
  end if;

  v_stats := coalesce(nullif(current_setting('app.delete_account_stats', true), '')::jsonb, '{}'::jsonb);

  return 'deleted: ' || concat_ws('; ',
    case v_stats->>'profile'
      when 'tombstoned' then 'profile tombstoned'
      when 'already' then 'profile was already a tombstone'
      else 'no profile'
    end,
    case when coalesce((v_stats->>'auth_removed')::bigint, 0) > 0 then 'auth user removed' else 'no auth user' end,
    format('groups left %s of %s (%s deleted)',
      coalesce((v_stats->>'groups_left')::int, 0),
      coalesce((v_stats->>'groups_total')::int, 0),
      coalesce((v_stats->>'groups_deleted')::int, 0)),
    format('schedules stopped %s', coalesce((v_stats->>'schedules_stopped')::int, 0)),
    format('future rows removed %s', coalesce((v_stats->>'future_rows_removed')::bigint, 0)),
    format('contact requests removed %s', coalesce((v_stats->>'requests_removed')::bigint, 0)),
    format('contacts removed %s of %s pairs',
      coalesce((v_stats->>'pairs_removed')::int, 0),
      coalesce((v_stats->>'pairs_total')::int, 0)),
    format('audit rows removed %s%s',
      coalesce((v_stats->>'audit_removed')::bigint, 0),
      case v_stats->>'audit_state'
        when 'refused' then ' (cleanup refused)'
        when 'no table' then ' (no audit table)'
        else ''
      end)
  );
end;
$$;

revoke execute on function public.admin_delete_account(uuid) from public, anon, authenticated;
grant execute on function public.admin_delete_account(uuid) to service_role;
