-- get_contacts_with_combined_balances also returns contact_deleted_at (appended
-- last): the contact's profiles.deleted_at, set when that person deleted their
-- account. The client uses it to stop offering a deleted contact in new 1-on-1
-- expenses, which the server refuses ("Deleted users cannot be added to new
-- expenses"). The return type changes, so the function is dropped first: a
-- leftover overload makes PostgREST answer PGRST203. The drop loses the grants;
-- the re-created function keeps the default execute grants it had (it is neither
-- granted nor revoked explicitly).

drop function if exists public.get_contacts_with_combined_balances();

create or replace function public.get_contacts_with_combined_balances()
returns table (
  contact_user_id uuid,
  full_name text,
  avatar_url text,
  currency text,
  balance numeric(12, 2),
  is_accepted boolean,
  contact_deleted_at timestamptz
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
  with accepted as (
    select c.contact_user_id as uid
    from public.contacts c
    where c.owner_id = v_uid
  ),
  contact_ids as (
    select uid from accepted
    union
    select case when ce.user_lo = v_uid then ce.user_hi else ce.user_lo end as uid
    from public.contact_expenses ce
    where ce.user_lo = v_uid or ce.user_hi = v_uid
    union
    select case when cp.user_lo = v_uid then cp.user_hi else cp.user_lo end as uid
    from public.contact_payments cp
    where cp.user_lo = v_uid or cp.user_hi = v_uid
    union
    -- Group-mates: anyone sharing a group with the caller (covers simplified
    -- "phantom" debts and direct group balances with non-contacts).
    select gm2.user_id as uid
    from public.group_members gm1
    join public.group_members gm2 on gm2.group_id = gm1.group_id
    where gm1.user_id = v_uid and gm2.user_id <> v_uid
  ),
  contacts_resolved as (
    select
      ci.uid,
      p.full_name,
      p.avatar_url,
      (ci.uid in (select a.uid from accepted a)) as is_accepted,
      p.deleted_at
    from contact_ids ci
    join public.profiles p on p.id = ci.uid
    where ci.uid <> v_uid
  )
  select
    cr.uid,
    cr.full_name,
    cr.avatar_url,
    ctx.currency,
    ctx.balance,
    cr.is_accepted,
    cr.deleted_at
  from contacts_resolved cr
  cross join lateral public.get_contact_balance_contexts(cr.uid) ctx
  where cr.is_accepted or abs(ctx.balance) > 0.005
  order by cr.full_name;
end;
$$;
