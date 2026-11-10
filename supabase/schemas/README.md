# Declarative database schema

These files are the **source of truth** for the SplitBill database structure.
Each file declares the *desired end-state* of the database (plain `create`
statements as they should look right now), not incremental changes.

```
schemas/
  01_types.sql            split_type enum
  02_tables_core.sql      groups / members / expenses / splits / payments
  03_tables_contacts.sql  contacts and one-on-one contact expenses
  04_functions.sql        RPCs + RLS helper functions
  05_policies.sql         row level security policies
```

Apply order is pinned in `supabase/config.toml` under `[db.migrations]`
`schema_paths`. It must stay dependency-ordered: types -> tables -> functions
-> policies.

## Workflow

You **edit the schema files**, then let the CLI generate the migration:

```bash
# 1. Edit the relevant schemas/*.sql file (e.g. add a column to expenses).
# 2. Generate a migration capturing the delta vs current migration history.
#    --schema public scopes the diff to our schema and avoids touching the
#    auth-schema trigger (see "What is intentionally NOT in these files").
supabase db diff --schema public -f describe_your_change
# 3. Review the generated supabase/migrations/<timestamp>_describe_your_change.sql
# 4. Verify it reproduces the intended state locally:
supabase db reset
# 5. Push to the remote project:
supabase db push
```

> Always pass `--schema public`. A bare `supabase db diff` also diffs the `auth`
> schema and will emit a `drop trigger on_auth_user_created` because that
> trigger is intentionally kept out of `schemas/` (see below).

Never hand-edit a generated migration's intent away — fix the schema file and
regenerate instead. The diff tool is not foolproof, so **always review** the
generated SQL before pushing.

## What is intentionally NOT in these files

`supabase db diff` only tracks the `public` schema and a subset of object types.
The following are kept in versioned migrations under `supabase/migrations/` and
must be maintained there by hand:

- **The `on_auth_user_created` trigger** on `auth.users` (calls
  `public.handle_new_user()`). Triggers on the `auth` schema are not tracked.
  The function itself lives in `04_functions.sql`; only the trigger is manual.
- **The `on_auth_user_deleted` trigger** on `auth.users` (AFTER DELETE, calls
  `public._tombstone_deleted_auth_user()`). Same rule: the function is in
  `04_functions.sql`, the trigger is manual.
- **The `supabase_realtime` publication** membership
  (`alter publication supabase_realtime add table ...` for expenses,
  expense_splits, payments, group_members, contact_requests,
  recurring_schedules). Publications are not tracked.
- **Seed / backfill data** (`insert`/`update`/`delete`). DML is never captured
  by the diff tool; see `supabase/seed.sql`.

If you add any of the above categories, write a normal migration for it — do
not put it in `schemas/`, or the next `supabase db diff` may try to drop it.

## Baseline (already done)

The migration history has been baselined for the declarative workflow:

- `migrations/000_full_setup.sql` is the **single baseline** migration. It
  reproduces the entire current database, including the auth trigger and
  realtime publication that must stay manual.
- `migrations/20260623043515_normalize_function_formatting.sql` is a one-time,
  behavior-preserving migration that re-emits the functions in the canonical
  format used by `schemas/04_functions.sql` (all `create or replace`). With it
  applied, `supabase db diff --schema public` is **empty** — i.e. the declared
  schema and the migration history describe the same database. This was
  verified locally.
- The original incremental migrations `001`–`014` were moved to
  `migrations/_archive/` (the CLI only scans top-level `*.sql`, so they are not
  replayed). They are kept for git history only.

### Remaining one-time step (linking the remote)

> Only for the original project, which was provisioned by hand. **On a new,
> empty project do not run `migration repair`**: it skips the baseline and the
> next `supabase db push` fails partway. See [`SETUP.md`](../../SETUP.md).

The remote project was provisioned by running `000_full_setup.sql` in the SQL
editor, not through CLI migration tracking. So the first time you link the CLI,
mark the baseline as already applied to avoid re-running it:

```bash
supabase link --project-ref <ref>
supabase migration repair --status applied 000
# Then push the (idempotent) normalization migration:
supabase db push
```
