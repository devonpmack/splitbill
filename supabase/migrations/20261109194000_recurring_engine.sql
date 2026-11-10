-- The recurring engine: occurrence dates, the FX conversion port, _materialise_one
-- (one schedule), the runner cron and the app-open catch-up share, and the
-- client-callable catch-up wrapper. Every private (underscore) function has its
-- client execute revoked in the same migration.

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

-- The exchange rate an occurrence converts at. Until a server-side rate source
-- exists this is the schedule's last known rate; same-currency schedules never
-- ask (the engine uses rate 1).
create or replace function public._schedule_rate(p_schedule public.recurring_schedules)
returns numeric
language sql
stable
set search_path = public, pg_temp
as $$
  select p_schedule.last_exchange_rate
$$;

revoke execute on function public._schedule_rate(public.recurring_schedules)
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
    if not public.is_group_member(v_s.group_id, v_s.paid_by) then
      raise exception 'schedule member left' using errcode = 'EVNTM';
    end if;
    for v_member in
      select distinct (e->>'userId')::uuid from jsonb_array_elements(v_s.splits) e
    loop
      if not public.is_group_member(v_s.group_id, v_member) then
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
        update public.recurring_schedules
        set stopped_at = now(), stop_reason = 'member left',
          last_error = 'This repeating item was stopped.'
        where id = v_id and stopped_at is null;
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
