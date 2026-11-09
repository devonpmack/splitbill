# SplitBill

A bill splitting app built with Expo (React Native) and Supabase.

## Tech Stack

- **Frontend**: Expo SDK 54, TypeScript, Expo Router, React Native Paper (MD3)
- **Backend**: Supabase (PostgreSQL, Auth, Realtime, RLS)
- **State Management**: TanStack Query v5
- **Forms**: local component state with hand-rolled validation

## Features

- Email/password authentication
- Create and manage expense groups
- Add expenses with equal, exact amount, or percentage splits
- Real-time balance tracking per group
- Debt simplification (minimize number of payments)
- Settle-up payments between members
- Pull-to-refresh and realtime updates
- Beautiful, modern UI with React Native Paper (Material Design 3)

## Getting Started

### Prerequisites

- Node.js 18+
- Expo CLI (`npm install -g expo-cli`)
- A [Supabase](https://supabase.com) project

### 1. Install dependencies

```bash
npm install
```

### 2. Set up Supabase

Step-by-step instructions for a new project (org, region, auth settings, keys,
cost) are in [`SETUP.md`](SETUP.md). The short version:

The database is defined declaratively in `supabase/schemas/`; migrations under
`supabase/migrations/` are generated from it. See
[`supabase/schemas/README.md`](supabase/schemas/README.md) for the full
workflow.

1. Create a new project at [supabase.com](https://supabase.com)
2. Link the CLI and apply the migration history:

```bash
supabase link --project-ref <your-project-ref>
supabase db push
```

To run against a local stack instead, `supabase db reset` builds the whole
database (schema, policies, grants and seed data) from scratch.

Realtime is enabled for `expenses`, `expense_splits`, `payments`,
`group_members` and `contact_requests` by the migrations, so there is nothing
to toggle in the dashboard.

### 3. Configure environment

Copy `.env.example` to `.env` and fill in your Supabase credentials:

```bash
cp .env.example .env
```

```
EXPO_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=your-anon-key-here
```

### 4. Run the app

```bash
npx expo start
```

Then press `i` for iOS simulator, `a` for Android emulator, or scan the QR code with Expo Go.

## Project Structure

```
app/                  # Expo Router file-based routes
  (auth)/             # Sign-in / Sign-up screens
  (tabs)/             # Main tab navigator
    (home)/           # Dashboard, contact detail, contact expenses
    groups/           # Group list and detail
    activity/         # Activity feed
    account/          # Profile, edit profile, notifications, help & support
  group-*.tsx         # Group action screens, presented as modals over the tabs
components/           # Reusable UI components
lib/                  # Core logic
  supabase.ts         # Supabase client
  auth.tsx            # Auth context provider
  queries/            # TanStack Query hooks
  types.ts            # TypeScript types
  utils.ts            # Utility functions
  realtime.ts         # Realtime subscriptions
supabase/
  schemas/            # Declarative schema (source of truth)
  migrations/         # Generated migration history
```

## Database access model

Clients read through Row Level Security and write **only** through
`SECURITY DEFINER` RPCs. `anon` and `authenticated` hold `SELECT` and nothing
else, and every table carries SELECT policies only.

This is deliberate. RLS can express "you are a member of this group" but not
"these split amounts add up to the expense total", so an open INSERT policy on
`expense_splits` would let a client PostgREST call skip every validation the
RPCs perform and write a ledger that does not balance. Keeping writes behind
functions puts the invariants in one place.

Adding a write path means adding an RPC in `supabase/schemas/04_functions.sql`,
not a policy in `05_policies.sql`. `tests/sql-security.test.ts` fails if a
non-SELECT policy or a non-SELECT client grant reappears.

## Checks

```bash
npm run lint        # eslint
npx tsc --noEmit    # type-check
npm test            # jest
```

All three run in CI, and the tests also run in a pre-commit hook.
