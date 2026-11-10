-- Account deletion, piece 2: group and membership logic.
--
-- A deleted account stays behind as a tombstone profile (profiles.deleted_at) and
-- may remain in a group as a ghost member, because balances join group_members.
--   * _group_member_balance: one member's net balance, the arithmetic of
--     get_group_balances without its auth.uid() gate.
--   * _account_leave_group: takes one user out of one group for an account
--     deletion (delete the group if nobody alive is left, hand it to the
--     longest-standing live member, drop the membership only when that moves no
--     one else's balance). Private; the deletion RPC will call it.
--   * leave_group hands the group to a live member and ignores ghosts when it
--     decides whether anyone is left.
--   * The four expense helpers refuse a tombstone as payer or participant of a new
--     expense (update_recurring_schedule refuses it too); _materialise_one stops a
--     schedule that includes one as 'member left'.
-- Replacing a function keeps its grants; the two new ones are revoked like every
-- other private helper.

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
