-- The server's "no account" errors reach the user word for word (the add-member
-- and add-contact screens show them), so they must not carry the product name:
-- the app has already been renamed once, and a name in a SQL string needs a new
-- migration for every rename. They now say "No account found for ..." and the
-- app name stays out of the database. Only the message text changes (create or
-- replace keeps each function's signature and grants).

create or replace function public.create_group_with_members(
  p_name text,
  p_member_emails text[] default '{}',
  p_currency text default 'USD'
)
returns public.groups
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_group public.groups;
  v_emails text[];
  v_missing text[];
  v_member_id uuid;
  v_currency text := upper(btrim(coalesce(p_currency, 'USD')));
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if btrim(coalesce(p_name, '')) = '' then
    raise exception 'Group name is required';
  end if;

  v_emails := public.normalize_invite_emails(p_member_emails);

  if coalesce(array_length(v_emails, 1), 0) > 20 then
    raise exception 'Too many emails requested';
  end if;

  select coalesce(array_agg(e), '{}'::text[])
  into v_missing
  from unnest(v_emails) as e
  where not exists (
    select 1
    from auth.users au
    join public.profiles p on p.id = au.id
    where lower(au.email) = e
  );

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception 'No account found for: %',
      array_to_string(v_missing, ', ');
  end if;

  insert into public.groups (name, created_by, currency)
  values (btrim(p_name), v_uid, v_currency)
  returning * into v_group;

  insert into public.group_members (group_id, user_id)
  values (v_group.id, v_uid);

  for v_member_id in
    select p.id
    from auth.users au
    join public.profiles p on p.id = au.id
    where lower(au.email) = any(v_emails)
  loop
    if v_member_id <> v_uid then
      insert into public.group_members (group_id, user_id)
      values (v_group.id, v_member_id)
      on conflict (group_id, user_id) do nothing;
    end if;
  end loop;

  return v_group;
end;
$$;

create or replace function public.add_group_members(
  p_group_id uuid,
  p_member_emails text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_emails text[];
  v_missing text[];
  v_existing text[];
  v_member_id uuid;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if not public.is_group_member(p_group_id, v_uid) then
    raise exception 'You are not a member of this group';
  end if;

  v_emails := public.normalize_invite_emails(p_member_emails);

  if coalesce(array_length(v_emails, 1), 0) = 0 then
    raise exception 'Add at least one other person''s email';
  end if;

  if array_length(v_emails, 1) > 20 then
    raise exception 'Too many emails requested';
  end if;

  select coalesce(array_agg(e), '{}'::text[])
  into v_missing
  from unnest(v_emails) as e
  where not exists (
    select 1
    from auth.users au
    join public.profiles p on p.id = au.id
    where lower(au.email) = e
  );

  if coalesce(array_length(v_missing, 1), 0) > 0 then
    raise exception 'No account found for: %',
      array_to_string(v_missing, ', ');
  end if;

  select coalesce(array_agg(e), '{}'::text[])
  into v_existing
  from unnest(v_emails) as e
  where exists (
    select 1
    from auth.users au
    join public.group_members gm on gm.user_id = au.id
    where lower(au.email) = e and gm.group_id = p_group_id
  );

  if coalesce(array_length(v_existing, 1), 0) > 0 then
    raise exception 'Already in this group: %',
      array_to_string(v_existing, ', ');
  end if;

  for v_member_id in
    select p.id
    from auth.users au
    join public.profiles p on p.id = au.id
    where lower(au.email) = any(v_emails)
  loop
    insert into public.group_members (group_id, user_id)
    values (p_group_id, v_member_id);
  end loop;
end;
$$;

create or replace function public.send_contact_request(p_recipient_email text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := lower(btrim(coalesce(p_recipient_email, '')));
  v_recipient uuid;
  v_reverse public.contact_requests;
begin
  if v_uid is null then
    raise exception 'Not authenticated';
  end if;

  if v_email = '' then
    raise exception 'Enter an email address';
  end if;

  select p.id into v_recipient
  from auth.users au
  join public.profiles p on p.id = au.id
  where lower(au.email) = v_email;

  if v_recipient is null then
    raise exception 'No account found for %', v_email;
  end if;

  if v_recipient = v_uid then
    raise exception 'You cannot add yourself as a contact';
  end if;

  if exists (
    select 1 from public.contacts
    where owner_id = v_uid and contact_user_id = v_recipient
  ) then
    raise exception 'This person is already a contact';
  end if;

  -- Mutual intent: if they already requested me, accept it instead.
  select * into v_reverse
  from public.contact_requests
  where requester_id = v_recipient
    and recipient_id = v_uid
    and status = 'pending';

  if found then
    update public.contact_requests
    set status = 'accepted', responded_at = now()
    where id = v_reverse.id;
    perform public.create_contact_pair(v_uid, v_recipient);
    return;
  end if;

  insert into public.contact_requests (requester_id, recipient_id, status)
  values (v_uid, v_recipient, 'pending')
  on conflict (requester_id, recipient_id)
  do update set status = 'pending', created_at = now(), responded_at = null;
end;
$$;
