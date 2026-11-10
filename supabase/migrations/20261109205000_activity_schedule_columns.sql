-- get_recent_activity and get_upcoming_expenses also return schedule_id,
-- occurrence_date and hand_edited (appended last, in that order) so the client can
-- mark an expense as repeating, show its schedule's calendar date, and tell a
-- hand-moved occurrence from an untouched one. The return type changes, so each
-- function is dropped first: a leftover overload makes PostgREST answer PGRST203.
-- The drop loses the grants; the re-created functions keep the default execute
-- grants they had (neither is granted or revoked explicitly).

drop function if exists public.get_recent_activity(int);
drop function if exists public.get_upcoming_expenses(int);

-- Recent group-expense activity for the caller's own feed.
--
-- "Involved" means the caller paid for the expense or holds a non-zero split in
-- it. That predicate has to run before the row cap: applying a limit first and
-- filtering on the client pushed the caller's own items out of the feed in busy
-- groups. Nested payer/group/split data is returned as jsonb so the shape
-- matches what the client already renders. schedule_id, occurrence_date and
-- hand_edited (the last three columns) say which recurring schedule made the
-- expense, for which calendar date, and whether someone edited it by hand (a
-- moved occurrence keeps its occurrence_date while its date changes). The first
-- two are null for an expense no schedule made; hand_edited is false for it.
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
  expense_splits jsonb,
  schedule_id uuid,
  occurrence_date date,
  hand_edited boolean
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
    ) as expense_splits,
    e.schedule_id,
    e.occurrence_date,
    e.hand_edited
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
  expense_splits jsonb,
  schedule_id uuid,
  occurrence_date date,
  hand_edited boolean
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
    ) as expense_splits,
    e.schedule_id,
    e.occurrence_date,
    e.hand_edited
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
