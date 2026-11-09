-- Core group-expense tables, indexes, and RLS enablement.
--
-- NOTE: append new columns at the END of each table. The diff tool emits
-- positional ALTERs, so inserting a column mid-table produces a noisier diff.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  image_url text,
  created_by uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Base currency the group's balances and settle-up are expressed in.
  currency text not null default 'USD',
  -- When true, balances/settle-up show greedy minimum-transfer suggestions.
  -- When false, the raw pairwise "who owes whom" ledger is shown instead.
  simplify_debts boolean not null default true
);

create table public.group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);

-- A repeating expense, for a group (group_id) or a contact pair (user_lo <
-- user_hi, as in contact_expenses). It holds the payload the create-expense
-- RPCs take; each occurrence becomes an ordinary expense row linked back by
-- (schedule_id, occurrence_date). Declared before expenses, which reference it.
-- next_index is the n of the next occurrence to create and only ever grows.
-- last_exchange_rate is the rate the latest occurrence converted at (the
-- creation-day rate at first); each occurrence converts at its own day's rate.
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

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  paid_by uuid not null references public.profiles (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  description text not null,
  category text,
  split_type public.split_type not null default 'equal',
  date timestamptz not null default now(),
  created_at timestamptz not null default now(),
  -- Currency the expense was entered in. base_amount is `amount` converted to
  -- the group's base currency at exchange_rate, captured at entry time so
  -- balances never drift with the market.
  currency text not null default 'USD',
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  base_amount numeric(12, 2) not null default 0 check (base_amount >= 0),
  -- Set when the row is an occurrence of a recurring schedule.
  schedule_id uuid references public.recurring_schedules (id) on delete set null,
  occurrence_date date,
  -- A member edited this occurrence; schedule edits and stops leave it alone.
  hand_edited boolean not null default false
);

create table public.expense_splits (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 0),
  unique (expense_id, user_id),
  -- The split's share converted to the group's base currency. Balance math
  -- sums base_amount so cross-currency expenses net out correctly.
  base_amount numeric(12, 2) not null default 0 check (base_amount >= 0)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  paid_by uuid not null references public.profiles (id) on delete cascade,
  paid_to uuid not null references public.profiles (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now(),
  check (paid_by != paid_to),
  -- Settle-up payments are entered in the group's base currency (rate 1), but
  -- the columns mirror expenses so a foreign-currency payment can be recorded.
  currency text not null default 'USD',
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  base_amount numeric(12, 2) not null default 0 check (base_amount >= 0)
);

create table public.group_simplify_debts_events (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  actor_id uuid not null references public.profiles (id) on delete cascade,
  -- The simplify_debts value the group was changed TO.
  enabled boolean not null,
  created_at timestamptz not null default now()
);

create index idx_group_members_group on public.group_members (group_id);
create index idx_group_members_user on public.group_members (user_id);
create index idx_expenses_group on public.expenses (group_id);
create index idx_expenses_paid_by on public.expenses (paid_by);
create index idx_expense_splits_expense on public.expense_splits (expense_id);
create index idx_expense_splits_user on public.expense_splits (user_id);
create index idx_payments_group on public.payments (group_id);
create index idx_payments_paid_by on public.payments (paid_by);
create index idx_payments_paid_to on public.payments (paid_to);
create index idx_group_simplify_debts_events_group on public.group_simplify_debts_events (group_id);
create index idx_recurring_schedules_group on public.recurring_schedules (group_id);
create index idx_recurring_schedules_pair on public.recurring_schedules (user_lo, user_hi);
create index idx_recurring_schedules_active on public.recurring_schedules (start_date)
  where stopped_at is null;
-- One expense per schedule per occurrence date, whoever creates it.
create unique index idx_expenses_schedule_occurrence on public.expenses (schedule_id, occurrence_date)
  where schedule_id is not null;

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_splits enable row level security;
alter table public.payments enable row level security;
alter table public.group_simplify_debts_events enable row level security;
alter table public.recurring_schedules enable row level security;

-- Grants.
--
-- Least privilege, matching the policies in 05_policies.sql: clients read under
-- RLS and write only through the SECURITY DEFINER RPCs, so anon/authenticated
-- get SELECT and nothing else.
--
-- These have to be declared here rather than left to Supabase's default
-- privileges. The baseline migration creates the tables with no grants of its
-- own, so without this block a fresh `supabase db reset` yields a database the
-- app cannot even read from, and local and remote drift apart.
grant select on table
  public.profiles,
  public.groups,
  public.group_members,
  public.expenses,
  public.expense_splits,
  public.payments,
  public.group_simplify_debts_events,
  public.recurring_schedules
  to anon, authenticated;

grant all on table
  public.profiles,
  public.groups,
  public.group_members,
  public.expenses,
  public.expense_splits,
  public.payments,
  public.group_simplify_debts_events,
  public.recurring_schedules
  to service_role;

-- Supabase's default privileges hand anon/authenticated the remainder of `all`
-- (references/trigger/truncate) on anything created in this schema. A client
-- needs none of them, and TRUNCATE in particular is not mediated by RLS, so
-- strip them back to the SELECT above.
revoke insert, update, delete, truncate, references, trigger on table
  public.profiles,
  public.groups,
  public.group_members,
  public.expenses,
  public.expense_splits,
  public.payments,
  public.group_simplify_debts_events,
  public.recurring_schedules
  from anon, authenticated;
