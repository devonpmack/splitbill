-- Recurring expenses: one schedule row per series, holding the same payload the
-- create-expense RPCs take. Occurrences become ordinary expenses linked back by
-- (schedule_id, occurrence_date); the unique index makes creating one twice a
-- no-op. Clients read schedules under RLS and write only through RPCs.

create table public.recurring_schedules (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('group', 'contact')),
  group_id uuid references public.groups (id) on delete cascade,
  user_lo uuid references public.profiles (id) on delete cascade,
  user_hi uuid references public.profiles (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  paid_by uuid not null references public.profiles (id) on delete cascade,
  description text not null,
  category text,
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null default 'USD',
  last_exchange_rate numeric(18, 8) not null check (last_exchange_rate > 0),
  split_type public.split_type not null default 'equal',
  splits jsonb not null,
  start_date date not null,
  tz text not null,
  frequency text not null check (frequency in ('daily', 'weekly', 'biweekly', 'monthly', 'yearly')),
  end_date date,
  max_count int check (max_count > 0),
  next_index int not null default 0,
  stopped_at timestamptz,
  stop_reason text,
  created_at timestamptz not null default now(),
  last_error text,
  failed_runs int not null default 0,
  check (user_lo < user_hi),
  constraint recurring_schedules_scope_check check (
    (kind = 'group' and group_id is not null and user_lo is null and user_hi is null)
    or (kind = 'contact' and group_id is null and user_lo is not null and user_hi is not null)
  )
);

create index idx_recurring_schedules_group on public.recurring_schedules (group_id);
create index idx_recurring_schedules_pair on public.recurring_schedules (user_lo, user_hi);
create index idx_recurring_schedules_active on public.recurring_schedules (start_date)
  where stopped_at is null;

alter table public.expenses
  add column schedule_id uuid references public.recurring_schedules (id) on delete set null,
  add column occurrence_date date,
  add column hand_edited boolean not null default false;

alter table public.contact_expenses
  add column schedule_id uuid references public.recurring_schedules (id) on delete set null,
  add column occurrence_date date,
  add column hand_edited boolean not null default false;

create unique index idx_expenses_schedule_occurrence on public.expenses (schedule_id, occurrence_date)
  where schedule_id is not null;
create unique index idx_contact_expenses_schedule_occurrence on public.contact_expenses (schedule_id, occurrence_date)
  where schedule_id is not null;

alter table public.recurring_schedules enable row level security;

grant select on table public.recurring_schedules to anon, authenticated;
grant all on table public.recurring_schedules to service_role;
revoke insert, update, delete, truncate, references, trigger on table public.recurring_schedules
  from anon, authenticated;

create policy "Members can view group recurring schedules"
  on public.recurring_schedules for select
  using (public.is_group_member(group_id, auth.uid()));

create policy "Participants can view contact recurring schedules"
  on public.recurring_schedules for select
  using (auth.uid() = user_lo or auth.uid() = user_hi);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'recurring_schedules'
  ) then
    alter publication supabase_realtime add table public.recurring_schedules;
  end if;
end $$;
