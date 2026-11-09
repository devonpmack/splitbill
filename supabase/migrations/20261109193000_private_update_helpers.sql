-- Behaviour-preserving extraction of the two expense-update bodies into private
-- helpers that take the acting user as a parameter (the recurring update has no
-- JWT) and a p_mark_hand_edited flag. The public RPCs keep their signatures and
-- become thin wrappers that pass true, so editing a schedule-linked row by hand
-- sets hand_edited; the helpers are not executable by clients.

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

  if p_amount <= 0 then
    raise exception 'Expense amount must be greater than zero';
  end if;

  if v_rate <= 0 then
    raise exception 'Exchange rate must be greater than zero';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Expense description is required';
  end if;

  v_base_amount := round(p_amount * v_rate, 2);

  for v_split in select value from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb))
  loop
    v_split_user := (v_split->>'userId')::uuid;
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

  if p_amount <= 0 then
    raise exception 'Expense amount must be greater than zero';
  end if;

  if v_rate <= 0 then
    raise exception 'Exchange rate must be greater than zero';
  end if;

  if btrim(coalesce(p_description, '')) = '' then
    raise exception 'Expense description is required';
  end if;

  v_base_amount := round(p_amount * v_rate, 2);

  for v_split in select value from jsonb_array_elements(coalesce(p_splits, '[]'::jsonb))
  loop
    v_split_user := (v_split->>'userId')::uuid;
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
