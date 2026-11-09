# Setting up SplitBill on your own Supabase project

About 10 minutes, start to a working sign-in. Everything below is done by you
in the Supabase dashboard and your own terminal. Nothing in this repo creates an
account, signs in or holds a key, and nothing secret is ever committed.

The dashboard's labels move around from time to time. If a menu below is named
slightly differently, the setting is the same one.

## Plan

This guide uses the **Free** plan ($0). One thing to know: a Free project that
sees no activity for 7 days is **paused**, and the app cannot reach it until you
restore it (below). Check [supabase.com/pricing](https://supabase.com/pricing)
for the current limits.

## 1. Create the organization and project

1. Sign in at [supabase.com/dashboard](https://supabase.com/dashboard).
2. **New organization**: name it `Overture`, type of organization as you see
   fit, plan **Free**.
3. **New project** in that organization:
   - Name: `splitbill`
   - Database password: generate one and keep it in your password manager. You
     need it once, for `supabase link` below. Never put it in a file in this repo.
   - Region: the one closest to the people who will use the app. It cannot be
     changed later.
   - Plan: Free.
4. Wait for the project to finish provisioning (a minute or two).
5. Note the **project reference**: the short id in the project URL
   (`https://<project-ref>.supabase.co`), also under *Project Settings → General*.

## 2. Build the database

Install the CLI once and sign in (it opens your browser):

```bash
brew install supabase/tap/supabase
supabase login
```

From the root of this repo:

```bash
supabase link --project-ref <project-ref>
supabase db push
```

`link` asks for the database password from step 1. `db push` lists the 26
migrations in `supabase/migrations/` and asks you to confirm; answer yes.

> **Do not run `supabase migration repair --status applied 000`.** That line in
> `supabase/schemas/README.md` was written for the original project, where
> `000_full_setup.sql` had already been run by hand. On your new empty project
> it would mark the whole baseline as done without running it, and you would
> get a database with no tables.

To check it worked, open *Table Editor*: you should see 13 tables in the
`public` schema: `profiles`, `groups`, `group_members`, `expenses`,
`expense_splits`, `payments`, `contacts`, `contact_requests`, `contact_expenses`,
`contact_expense_splits`, `contact_payments`, `contact_pair_settings` and
`group_simplify_debts_events`.

No CLI? You can instead paste the files into *SQL Editor* one at a time, in
filename order, starting with `000_full_setup.sql`. The CLI is better because it
records which migrations have run.

## 3. Auth settings

Under *Authentication*:

- **Providers → Email**: enabled (it is by default). The app signs up and signs
  in with email and password only. The app itself asks for at least 6
  characters.
- **Confirm email**: turn it **off** for your first run. The app has no code to
  catch a confirmation link (it never sets `emailRedirectTo` and has no deep-link
  handler), and the built-in email sender is heavily rate-limited. With it off,
  sign-up works immediately and the sign-up screen's "sign in now" is true.
  If you leave it on, a new user must click the emailed link before they can sign
  in; the link confirms the address and then lands on the Site URL below, and
  they go back to the app and sign in by hand.
- **URL Configuration**:
  - Site URL: `splitbill://` (the scheme in `app.json`).
  - Redirect URLs: add `splitbill://**`. For development in Expo Go also add
    `exp://**`.
  These only matter for emailed links (confirmation, and password reset if you
  add it); plain email-and-password sign-in does not use them.

## 4. Realtime

There is nothing to switch on. The migrations add `expenses`, `expense_splits`,
`payments`, `group_members` and `contact_requests` to the `supabase_realtime`
publication. To confirm, open *Database → Publications* and check that
`supabase_realtime` lists those five tables. Realtime still applies each user's
row-level security, so people only receive changes to groups they belong to.

## 5. Give the app the project URL and key

```bash
cp .env.example .env
```

Open `.env` (it is gitignored) and fill in:

```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=<paste the key here>
```

Both values are in *Project Settings → API* (some dashboards call the page *API
Keys*). Use the **anon / public** key, or the **publishable** key if that is what
your dashboard shows. Paste it yourself.

**Never use the `service_role` or *secret* key here.** Every `EXPO_PUBLIC_`
value is shipped inside the app bundle, and the service-role key bypasses all
row-level security.

## 6. Run it

```bash
npm install
npx expo start
```

Press `i` (iOS simulator), `a` (Android emulator), or scan the QR code with Expo
Go. Then:

1. Sign up with an email, a name and a password, and sign in.
2. Create a group, add an expense.
3. Realtime: sign up a second account, add it to the group (by the email you
   signed it up with), open the group on a second simulator or device, and add an
   expense on one. It should appear on the other without a refresh.

## If the project is paused

After 7 days without activity the Free plan pauses the project. Sign-in and
every screen will then fail to connect. To bring it back, open the project in the
dashboard and choose **Restore**. Regular use of the app keeps it from pausing.

Later, if you want it never to pause, upgrade the organization to Pro
(currently $25 a month). Nothing in the app or this guide changes.

## Checking the database without a project

```bash
npm run check:migrations
```

This builds an empty in-memory Postgres, applies every migration in order,
runs a sign-up, create-group, add-expense and balances flow through the real
RPCs as separate users, checks that row-level security hides a group from a
non-member and that clients cannot write tables directly, checks that the five
realtime tables are published, and checks that `supabase/schemas/` and
`supabase/migrations/` describe the same database. It needs no Docker and no
Supabase account, and it runs in CI. It does not run Supabase's auth, REST or
realtime servers, so it proves the database, not those layers.
