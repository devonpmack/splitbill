-- One-on-one contact tables (friends outside a group), indexes, and RLS.

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.profiles (id) on delete cascade,
  contact_user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (owner_id, contact_user_id),
  check (owner_id <> contact_user_id)
);

-- user_lo/user_hi store the participant pair in sorted order so a pair maps to
-- a single canonical row regardless of who created the expense.
create table public.contact_expenses (
  id uuid primary key default gen_random_uuid(),
  paid_by uuid not null references public.profiles (id) on delete cascade,
  user_lo uuid not null references public.profiles (id) on delete cascade,
  user_hi uuid not null references public.profiles (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  description text not null,
  category text,
  split_type public.split_type not null default 'equal',
  date timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (user_lo < user_hi),
  -- Currency the expense was entered in; base_amount is `amount` converted to
  -- the contact pair's base currency at exchange_rate (captured at entry).
  currency text not null default 'USD',
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  base_amount numeric(12, 2) not null default 0 check (base_amount >= 0),
  -- Set when the row is an occurrence of a recurring schedule.
  schedule_id uuid references public.recurring_schedules (id) on delete set null,
  occurrence_date date,
  -- A member edited this occurrence; schedule edits and stops leave it alone.
  hand_edited boolean not null default false
);

create table public.contact_expense_splits (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.contact_expenses (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  amount numeric(12, 2) not null check (amount >= 0),
  unique (expense_id, user_id),
  -- The split's share converted to the contact pair's base currency.
  base_amount numeric(12, 2) not null default 0 check (base_amount >= 0)
);

-- One-on-one settle-up payments between two contacts (outside any group).
-- user_lo/user_hi store the participant pair in sorted order, mirroring
-- contact_expenses, so a pair maps to a single canonical (lo, hi) regardless of
-- payment direction; paid_by/paid_to carry the direction.
create table public.contact_payments (
  id uuid primary key default gen_random_uuid(),
  paid_by uuid not null references public.profiles (id) on delete cascade,
  paid_to uuid not null references public.profiles (id) on delete cascade,
  user_lo uuid not null references public.profiles (id) on delete cascade,
  user_hi uuid not null references public.profiles (id) on delete cascade,
  amount numeric(12, 2) not null check (amount > 0),
  note text,
  created_at timestamptz not null default now(),
  check (paid_by <> paid_to),
  check (user_lo < user_hi),
  -- Settle-up payments are entered in the pair's base currency (rate 1); the
  -- columns mirror contact_expenses for consistency.
  currency text not null default 'USD',
  exchange_rate numeric(18, 8) not null default 1 check (exchange_rate > 0),
  base_amount numeric(12, 2) not null default 0 check (base_amount >= 0)
);

-- Base currency for a one-on-one contact ledger. The pair is stored in sorted
-- (user_lo < user_hi) order so it is canonical regardless of who set it. A row
-- is created lazily the first time either participant sets a non-default
-- currency; absence implies the default ('USD').
create table public.contact_pair_settings (
  user_lo uuid not null references public.profiles (id) on delete cascade,
  user_hi uuid not null references public.profiles (id) on delete cascade,
  currency text not null default 'USD',
  updated_at timestamptz not null default now(),
  primary key (user_lo, user_hi),
  check (user_lo < user_hi)
);

-- A contact only becomes a `contacts` row pair once the recipient accepts a
-- request. The unique pair lets a re-sent request reuse (reset) the prior row.
create table public.contact_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requester_id <> recipient_id),
  unique (requester_id, recipient_id)
);

create index idx_contacts_owner on public.contacts (owner_id);
create index idx_contacts_contact_user on public.contacts (contact_user_id);
create index idx_contact_expenses_paid_by on public.contact_expenses (paid_by);
create index idx_contact_expenses_user_lo on public.contact_expenses (user_lo);
create index idx_contact_expenses_user_hi on public.contact_expenses (user_hi);
-- One expense per schedule per occurrence date, whoever creates it.
create unique index idx_contact_expenses_schedule_occurrence on public.contact_expenses (schedule_id, occurrence_date)
  where schedule_id is not null;
create index idx_contact_expense_splits_expense on public.contact_expense_splits (expense_id);
create index idx_contact_expense_splits_user on public.contact_expense_splits (user_id);
create index idx_contact_payments_paid_by on public.contact_payments (paid_by);
create index idx_contact_payments_user_lo on public.contact_payments (user_lo);
create index idx_contact_payments_user_hi on public.contact_payments (user_hi);
create index idx_contact_requests_recipient on public.contact_requests (recipient_id);
create index idx_contact_requests_requester on public.contact_requests (requester_id);

alter table public.contacts enable row level security;
alter table public.contact_expenses enable row level security;
alter table public.contact_expense_splits enable row level security;
alter table public.contact_payments enable row level security;
alter table public.contact_requests enable row level security;
alter table public.contact_pair_settings enable row level security;

-- Grants. See the note in 02_tables_core.sql: read under RLS, write only
-- through the SECURITY DEFINER RPCs.
grant select on table
  public.contacts,
  public.contact_expenses,
  public.contact_expense_splits,
  public.contact_payments,
  public.contact_requests,
  public.contact_pair_settings
  to anon, authenticated;

grant all on table
  public.contacts,
  public.contact_expenses,
  public.contact_expense_splits,
  public.contact_payments,
  public.contact_requests,
  public.contact_pair_settings
  to service_role;

-- See the note in 02_tables_core.sql.
revoke insert, update, delete, truncate, references, trigger on table
  public.contacts,
  public.contact_expenses,
  public.contact_expense_splits,
  public.contact_payments,
  public.contact_requests,
  public.contact_pair_settings
  from anon, authenticated;
