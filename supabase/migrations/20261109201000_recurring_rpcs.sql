-- Recurring expenses, client RPCs: create_recurring_schedule and
-- stop_recurring_schedule. leave_group is replaced once, carrying both its
-- future-dated-row clause and the new active-schedule clause; set_group_currency
-- and set_contact_currency also refuse while a schedule is active. All new
-- functions are SECURITY DEFINER with search_path = public, pg_temp and keep the
-- default execute grants like the other client RPCs (anon is turned away by the
-- Not authenticated check).

-- Creates a repeating expense. Exactly one of p_group_id / p_contact_id is set;
-- p_contact_id is the OTHER person's profile id (the pair is derived from the
-- caller, and must be accepted contacts). The payload is the create-expense
-- payload: p_paid_by and p_splits ([{userId, amount}], any baseAmount is
-- ignored) are validated here by running the first occurrence through the
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
  v_split jsonb;
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

  if p_amount is null or p_amount <= 0 then
    raise exception 'Expense amount must be greater than zero';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Expense description is required';
  end if;

  if v_rate <= 0 then
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
      perform (v_split->>'userId')::uuid, (v_split->>'amount')::numeric;
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

  -- Trial run: the first occurrence, converted the way the engine converts it,
  -- through the same helper (payer, split users, amounts and totals), then undone.
  v_effective_rate := case when v_currency = upper(btrim(v_base)) then 1 else v_rate end;
  v_splits := public._convert_splits_to_base(p_splits, v_effective_rate, round(p_amount * v_effective_rate, 2));

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
    v_currency, v_rate, p_split_type, p_splits, p_start_date, p_tz, p_frequency, p_end_date, p_max_count
  )
  returning id into v_id;

  perform public._materialise_one(v_id, now() + interval '48 hours');

  select * into v_schedule from public.recurring_schedules where id = v_id;
  return v_schedule;
end;
$$;

-- Stops a repeating expense. Any member of the group (or either contact) may
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
      raise exception 'You are not a member of this group';
    end if;
  elsif v_uid <> v_schedule.user_lo and v_uid <> v_schedule.user_hi then
    raise exception 'You are not a participant in this schedule';
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

  select count(*) into v_other_count
  from public.group_members
  where group_id = p_group_id and user_id <> v_uid;

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
  -- completed): it will create occurrences, so it blocks its creator, its payer
  -- and every user in its splits. Any member may stop a schedule.
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
        s.created_by = v_uid
        or s.paid_by = v_uid
        or exists (
          select 1 from jsonb_array_elements(s.splits) sp
          where sp->>'userId' = v_uid::text
        )
      )
  ) then
    raise exception 'You have upcoming or repeating transactions in this group. Cancel or stop them before leaving.';
  end if;

  select created_by into v_created_by from public.groups where id = p_group_id;

  if v_created_by = v_uid then
    select user_id into v_new_owner
    from public.group_members
    where group_id = p_group_id and user_id <> v_uid
    order by joined_at asc
    limit 1;

    update public.groups set created_by = v_new_owner where id = p_group_id;
  end if;

  delete from public.group_members
  where group_id = p_group_id and user_id = v_uid;
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
