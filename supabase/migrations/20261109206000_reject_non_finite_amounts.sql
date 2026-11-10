-- Reject NaN and +/-Infinity in every money amount and exchange rate a client
-- can send to the expense and payment RPCs. Postgres evaluates `NaN <= 0` as
-- false (NaN sorts above every number), so the positivity checks let NaN and
-- Infinity through: create_expense_with_splits stored them and
-- get_group_balances then returned NaN. Each guard sits beside the existing
-- check for that field and raises that check's message; a split's amount and
-- baseAmount (JSON strings such as 'NaN') use the split-negative message.
-- Bodies are otherwise unchanged. create or replace keeps the grants, so the
-- revokes on the private helpers are repeated only to mirror schemas/04.

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
      raise exception 'Split amount cannot be negative';
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
      raise exception 'Split amount cannot be negative';
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
      raise exception 'Split amount cannot be negative';
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
      raise exception 'Split amount cannot be negative';
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
