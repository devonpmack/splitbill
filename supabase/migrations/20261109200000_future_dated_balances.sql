-- Future-dated rows count from their date. An expense, contact expense,
-- payment or contact payment whose `date` is after now() is left out of every
-- balance until that instant passes; nothing moves the row, the filter is
-- evaluated at query time.
--
-- The money is summed in get_group_balances, get_group_pairwise_balances,
-- get_contact_balance and get_contact_group_breakdown (its direct branch), so
-- those get `date <= now()`. Everything else inherits: get_group_simplified_edges
-- and leave_group's balance check read get_group_balances;
-- get_contacts_with_balances, get_contacts_with_combined_balances (via
-- get_contact_balance_contexts) and get_user_total_balance read the functions
-- above. set_group_currency / set_contact_currency already count every row,
-- future ones included, and are unchanged.
--
-- get_recent_activity leaves future rows out so they cannot fill its row cap;
-- get_upcoming_expenses returns them. leave_group refuses while a future row
-- involves the caller, since their zero balance today would move on its date.
--
-- Signatures are unchanged, so create or replace keeps the existing grants; the
-- new function takes the same default execute grants as every other RPC.

create or replace function public.get_group_balances(p_group_id uuid)
returns table (
  user_id uuid,
  full_name text,
  balance numeric(12, 2)
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_group_member(p_group_id, auth.uid()) then
    raise exception 'You are not a member of this group';
  end if;

  -- Sum base_amount (each row converted to the group's base currency at entry
  -- time) so cross-currency expenses net out correctly within the group. A row
  -- dated in the future counts from its date.
  return query
  select
    gm.user_id,
    p.full_name,
    coalesce(paid.total_paid, 0)
      - coalesce(owed.total_owed, 0)
      + coalesce(sent.total_sent, 0)
      - coalesce(received.total_received, 0)
    as balance
  from public.group_members gm
  join public.profiles p on p.id = gm.user_id
  left join (
    select e.paid_by as uid, sum(e.base_amount) as total_paid
    from public.expenses e
    where e.group_id = p_group_id and e.date <= now() group by e.paid_by
  ) paid on paid.uid = gm.user_id
  left join (
    select es.user_id as uid, sum(es.base_amount) as total_owed
    from public.expense_splits es
    join public.expenses e on e.id = es.expense_id
    where e.group_id = p_group_id and e.date <= now() group by es.user_id
  ) owed on owed.uid = gm.user_id
  left join (
    select py.paid_to as uid, sum(py.base_amount) as total_received
    from public.payments py
    where py.group_id = p_group_id and py.date <= now() group by py.paid_to
  ) received on received.uid = gm.user_id
  left join (
    select py.paid_by as uid, sum(py.base_amount) as total_sent
    from public.payments py
    where py.group_id = p_group_id and py.date <= now() group by py.paid_by
  ) sent on sent.uid = gm.user_id
  where gm.group_id = p_group_id;
end;
$$;

-- Raw pairwise "who owes whom" for the whole group (all member pairs, not just
-- the caller). Nets every unordered pair from expenses + settle-up payments
-- using base_amount, then emits one directed debtor->creditor edge per pair
-- with a non-trivial balance. Used when a group has debt simplification OFF.
create or replace function public.get_group_pairwise_balances(p_group_id uuid)
returns table (
  from_user uuid,
  from_name text,
  to_user uuid,
  to_name text,
  amount numeric(12, 2)
)
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

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  return query
  with raw_debts as (
    -- Expense: the member with a split (dr) owes the payer (cr).
    select es.user_id as dr, e.paid_by as cr, es.base_amount as amt
    from public.expenses e
    join public.expense_splits es on es.expense_id = e.id
    where e.group_id = p_group_id and es.user_id <> e.paid_by and e.date <= now()
    union all
    -- Settle-up payment from paid_by to paid_to reduces paid_by's debt, i.e.
    -- it is equivalent to paid_to owing paid_by the paid amount.
    select pmt.paid_to as dr, pmt.paid_by as cr, pmt.base_amount as amt
    from public.payments pmt
    where pmt.group_id = p_group_id and pmt.date <= now()
  ),
  pair_net as (
    select
      least(rd.dr, rd.cr) as u_lo,
      greatest(rd.dr, rd.cr) as u_hi,
      -- Positive net means u_lo owes u_hi.
      sum(case when rd.dr < rd.cr then rd.amt else -rd.amt end) as net_lo
    from raw_debts rd
    group by 1, 2
  ),
  edges as (
    select
      case when pn.net_lo > 0 then pn.u_lo else pn.u_hi end as from_user,
      case when pn.net_lo > 0 then pn.u_hi else pn.u_lo end as to_user,
      round(abs(pn.net_lo), 2)::numeric(12, 2) as amount
    from pair_net pn
    where abs(pn.net_lo) > 0.005
  )
  select ed.from_user, pf.full_name, ed.to_user, pt.full_name, ed.amount
  from edges ed
  join public.profiles pf on pf.id = ed.from_user
  join public.profiles pt on pt.id = ed.to_user
  order by pf.full_name, pt.full_name;
end;
$$;

create or replace function public.get_contact_balance(p_contact_user_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_lo uuid;
  v_hi uuid;
  v_expense_balance numeric(12, 2);
  v_payment_balance numeric(12, 2);
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if p_contact_user_id is null or p_contact_user_id = v_uid then
    return 0;
  end if;

  if v_uid < p_contact_user_id then
    v_lo := v_uid;
    v_hi := p_contact_user_id;
  else
    v_lo := p_contact_user_id;
    v_hi := v_uid;
  end if;

  select coalesce(sum(
    case
      when ce.paid_by = v_uid and ces.user_id = p_contact_user_id then ces.base_amount
      when ce.paid_by = p_contact_user_id and ces.user_id = v_uid then -ces.base_amount
      else 0
    end
  ), 0)
  into v_expense_balance
  from public.contact_expenses ce
  join public.contact_expense_splits ces on ces.expense_id = ce.id
  where ce.user_lo = v_lo and ce.user_hi = v_hi and ce.date <= now();

  -- A 1-on-1 payment you make to the contact settles your debt (raises the
  -- balance); a payment they make to you lowers it. Same sign rules as the
  -- shared-group payment term in get_contact_group_balance.
  select coalesce(sum(
    case
      when cp.paid_by = v_uid and cp.paid_to = p_contact_user_id then cp.base_amount
      when cp.paid_by = p_contact_user_id and cp.paid_to = v_uid then -cp.base_amount
      else 0
    end
  ), 0)
  into v_payment_balance
  from public.contact_payments cp
  where cp.user_lo = v_lo and cp.user_hi = v_hi and cp.date <= now();

  return coalesce(v_expense_balance, 0) + coalesce(v_payment_balance, 0);
end;
$$;

-- Per-group pairwise balance between the caller and a contact, for groups they
-- both belong to that have pairwise activity. Same sign rules as
-- get_contact_group_balance (positive = the contact owes you), but broken out
-- one row per group so the contact page can show a card per shared group.
create or replace function public.get_contact_group_breakdown(p_contact_user_id uuid)
returns table (
  group_id uuid,
  group_name text,
  balance numeric(12, 2),
  currency text
)
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

  if p_contact_user_id is null or p_contact_user_id = v_uid then
    return;
  end if;

  return query
  with shared_groups as (
    select g.id as gid, g.name, g.currency, g.simplify_debts
    from public.groups g
    where g.id in (
      select gm.group_id from public.group_members gm where gm.user_id = v_uid
      intersect
      select gm.group_id from public.group_members gm where gm.user_id = p_contact_user_id
    )
  ),
  -- Direct pairwise (toggle OFF): only expenses/payments between the two of us.
  direct_expense as (
    select e.group_id as gid, sum(
      case
        when e.paid_by = v_uid and es.user_id = p_contact_user_id then es.base_amount
        when e.paid_by = p_contact_user_id and es.user_id = v_uid then -es.base_amount
        else 0
      end
    ) as bal
    from public.expenses e
    join public.expense_splits es on es.expense_id = e.id
    where e.group_id in (select sg.gid from shared_groups sg where not simplify_debts)
      and e.date <= now()
      and (
        (e.paid_by = v_uid and es.user_id = p_contact_user_id)
        or (e.paid_by = p_contact_user_id and es.user_id = v_uid)
      )
    group by e.group_id
  ),
  direct_payment as (
    select pmt.group_id as gid, sum(
      case
        when pmt.paid_by = v_uid and pmt.paid_to = p_contact_user_id then pmt.base_amount
        when pmt.paid_by = p_contact_user_id and pmt.paid_to = v_uid then -pmt.base_amount
        else 0
      end
    ) as bal
    from public.payments pmt
    where pmt.group_id in (select sg.gid from shared_groups sg where not simplify_debts)
      and pmt.date <= now()
      and (
        (pmt.paid_by = v_uid and pmt.paid_to = p_contact_user_id)
        or (pmt.paid_by = p_contact_user_id and pmt.paid_to = v_uid)
      )
    group by pmt.group_id
  ),
  -- Simplified edge (toggle ON): the you<->contact edge in the minimal plan.
  simplified as (
    select sg.gid, sum(
      case
        when e.from_user = p_contact_user_id and e.to_user = v_uid then e.amount
        when e.from_user = v_uid and e.to_user = p_contact_user_id then -e.amount
        else 0
      end
    ) as bal
    from shared_groups sg
    cross join lateral public.get_group_simplified_edges(sg.gid) e
    where sg.simplify_debts
    group by sg.gid
  ),
  per_group as (
    select de.gid, de.bal from direct_expense de
    union all
    select dp.gid, dp.bal from direct_payment dp
    union all
    select s.gid, s.bal from simplified s
  ),
  totals as (
    select pg.gid, sum(pg.bal) as bal from per_group pg group by pg.gid
  )
  select sg.gid, sg.name, round(coalesce(t.bal, 0), 2)::numeric(12, 2), sg.currency
  from shared_groups sg
  left join totals t on t.gid = sg.gid
  where abs(coalesce(t.bal, 0)) > 0.005
  order by sg.name;
end;
$$;

-- Recent group-expense activity for the caller's own feed.
--
-- "Involved" means the caller paid for the expense or holds a non-zero split in
-- it. That predicate has to run before the row cap: applying a limit first and
-- filtering on the client pushed the caller's own items out of the feed in busy
-- groups. Nested payer/group/split data is returned as jsonb so the shape
-- matches what the client already renders.
create or replace function public.get_recent_activity(p_limit int default 50)
returns table (
  id uuid,
  description text,
  amount numeric,
  currency text,
  date timestamptz,
  paid_by uuid,
  group_id uuid,
  payer jsonb,
  groups jsonb,
  expense_splits jsonb
)
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

  return query
  select
    e.id,
    e.description,
    e.amount,
    e.currency,
    e.date,
    e.paid_by,
    e.group_id,
    to_jsonb(pr.*) as payer,
    jsonb_build_object('name', g.name) as groups,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('user_id', es.user_id, 'amount', es.amount)
        )
        from public.expense_splits es
        where es.expense_id = e.id
      ),
      '[]'::jsonb
    ) as expense_splits
  from public.expenses e
  join public.groups g on g.id = e.group_id
  join public.profiles pr on pr.id = e.paid_by
  where public.is_group_member(e.group_id, v_uid)
    and e.date <= now()
    and (
      e.paid_by = v_uid
      or exists (
        select 1 from public.expense_splits es
        where es.expense_id = e.id
          and es.user_id = v_uid
          and es.amount > 0
      )
    )
  order by e.date desc
  limit greatest(coalesce(p_limit, 50), 1);
end;
$$;

-- The caller's future-dated group expenses (date after now()), soonest first.
-- Same columns and "involved" rule as get_recent_activity, which leaves these
-- rows out so they cannot crowd its row cap.
create or replace function public.get_upcoming_expenses(p_limit int default 50)
returns table (
  id uuid,
  description text,
  amount numeric,
  currency text,
  date timestamptz,
  paid_by uuid,
  group_id uuid,
  payer jsonb,
  groups jsonb,
  expense_splits jsonb
)
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

  return query
  select
    e.id,
    e.description,
    e.amount,
    e.currency,
    e.date,
    e.paid_by,
    e.group_id,
    to_jsonb(pr.*) as payer,
    jsonb_build_object('name', g.name) as groups,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('user_id', es.user_id, 'amount', es.amount)
        )
        from public.expense_splits es
        where es.expense_id = e.id
      ),
      '[]'::jsonb
    ) as expense_splits
  from public.expenses e
  join public.groups g on g.id = e.group_id
  join public.profiles pr on pr.id = e.paid_by
  where public.is_group_member(e.group_id, v_uid)
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
  order by e.date asc
  limit greatest(coalesce(p_limit, 50), 1);
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
  -- date, so the caller cannot leave while one involves them. The recurring
  -- piece adds "or an active schedule involves them" to this same condition.
  if exists (
    select 1 from public.expenses e
    where e.group_id = p_group_id
      and e.date > now()
      and (
        e.paid_by = v_uid
        or exists (
          select 1 from public.expense_splits es
          where es.expense_id = e.id and es.user_id = v_uid
        )
      )
  ) or exists (
    select 1 from public.payments py
    where py.group_id = p_group_id
      and py.date > now()
      and v_uid in (py.paid_by, py.paid_to)
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
