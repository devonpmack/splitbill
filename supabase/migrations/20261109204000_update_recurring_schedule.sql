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
