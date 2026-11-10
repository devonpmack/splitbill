-- Payment dates. payments and contact_payments get a `date` (when the payment
-- counts toward balances, possibly in the future), and the four payment RPCs a
-- trailing p_date: on create null means now(), on update null keeps the stored
-- date so editing a note never moves a payment.
--
-- Existing rows take their created_at. The column is added nullable, backfilled,
-- then given its default and not null, so a populated database ends identical to
-- a fresh one.
--
-- No index on date: every query that will filter on it (the balance functions)
-- already narrows by group_id or the contact pair, which are indexed.

alter table public.payments add column date timestamptz;
update public.payments set date = created_at;
alter table public.payments
  alter column date set default now(),
  alter column date set not null;

alter table public.contact_payments add column date timestamptz;
update public.contact_payments set date = created_at;
alter table public.contact_payments
  alter column date set default now(),
  alter column date set not null;

-- Adding a parameter with create or replace would leave the old signature as a
-- second overload, which PostgREST cannot pick between. The re-created functions
-- get the same default execute grants the dropped ones had.
drop function if exists public.create_payment(p_group_id uuid, p_paid_by uuid, p_paid_to uuid, p_amount numeric, p_note text, p_currency text);

drop function if exists public.update_payment(p_payment_id uuid, p_paid_by uuid, p_paid_to uuid, p_amount numeric, p_note text);

drop function if exists public.create_contact_payment(p_contact_user_id uuid, p_paid_by uuid, p_paid_to uuid, p_amount numeric, p_note text, p_currency text);

drop function if exists public.update_contact_payment(p_payment_id uuid, p_paid_by uuid, p_paid_to uuid, p_amount numeric, p_note text);

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

  if p_amount is null or p_amount <= 0 then
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

  if p_amount is null or p_amount <= 0 then
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

  if p_amount is null or p_amount <= 0 then
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

  if p_amount is null or p_amount <= 0 then
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
