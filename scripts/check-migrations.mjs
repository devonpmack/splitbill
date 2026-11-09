// Applies every file in supabase/migrations, in order, to an empty in-process
// Postgres (PGlite) and then drives the real RPCs as signed-in users.
//
//   npm run check:migrations
//
// It needs no Docker, no Supabase CLI and no Supabase project. PGlite is real
// Postgres, so the plpgsql, RLS policies, grants and publications are the
// ones a fresh project would build (PGlite's Postgres version is newer than a
// project's, which is 15 to 17). What it stands in for is the part Supabase
// supplies before the first migration: the auth schema (auth.users, auth.uid()),
// the anon / authenticated roles and their default privileges. It does not run
// GoTrue, PostgREST or Realtime, so it proves the database, not the HTTP and
// websocket layers.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations"
);

const REALTIME_TABLES = [
  "contact_requests",
  "expense_splits",
  "expenses",
  "group_members",
  "payments",
];

// What a Supabase project provides before the first migration runs.
const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema extensions;
  create publication supabase_realtime;
  -- Supabase gives its API roles everything on whatever a migration creates in
  -- public; the hardening migration then has to take the write grants away.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

const db = new PGlite();
await db.exec(SUPABASE_STUBS);

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`FAIL  ${message}`);
};
const pass = (message) => console.log(`ok    ${message}`);
const check = (condition, message) =>
  condition ? pass(message) : fail(message);

const files = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();
for (const file of files) {
  try {
    await db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    pass(`applies ${file}`);
  } catch (error) {
    fail(`applies ${file}: ${String(error.message).split("\n")[0]}`);
  }
}
if (failures > 0) {
  console.error(`\n${failures} migration(s) failed; skipping the smoke test.`);
  process.exit(1);
}

// Runs fn as a signed-in user: the authenticated role, with the uid the
// policies and RPCs read from auth.uid().
async function asUser(userId, fn) {
  await db.exec(
    `set role authenticated; select set_config('request.jwt.claim.sub', '${userId}', false)`
  );
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false)`);
  }
}

async function signUp(email, fullName) {
  const meta = fullName ? { full_name: fullName } : {};
  const { rows } = await db.query(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`,
    [email, JSON.stringify(meta)]
  );
  return rows[0].id;
}

// Whether the promise fails, and with which SQLSTATE when one is asked for.
const rejects = async (promise, code) => {
  try {
    await promise;
    return false;
  } catch (error) {
    return code ? error.code === code : true;
  }
};

try {
  const alice = await signUp("alice@example.com", "Alice");
  const bob = await signUp("bob@example.com", "Bob");
  const carol = await signUp("carol@example.com", null);

  const profiles = await db.query(
    `select id, full_name from public.profiles order by full_name`
  );
  check(profiles.rows.length === 3, "sign-up creates a profile per user");
  check(
    profiles.rows.some((p) => p.id === carol && p.full_name === "carol@example.com"),
    "a sign-up with no name gets the email as its profile name"
  );

  const groupId = await asUser(alice, async () => {
    const { rows } = await db.query(
      `select * from public.create_group_with_members('Trip', array['bob@example.com'], 'USD')`
    );
    return rows[0].id;
  });
  const members = await db.query(
    `select user_id from public.group_members where group_id = $1`,
    [groupId]
  );
  check(members.rows.length === 2, "create_group_with_members seats the creator and the invited email");

  await asUser(alice, async () => {
    await db.query(
      `select public.create_expense_with_splits($1, $2, 30, 'Dinner', null, 'equal', $3::jsonb, null, 'USD', 1)`,
      [
        groupId,
        alice,
        JSON.stringify([
          { userId: alice, amount: 15, baseAmount: 15 },
          { userId: bob, amount: 15, baseAmount: 15 },
        ]),
      ]
    );
  });

  const balances = await asUser(bob, async () => {
    const { rows } = await db.query(
      `select user_id, balance from public.get_group_balances($1)`,
      [groupId]
    );
    return Object.fromEntries(rows.map((r) => [r.user_id, Number(r.balance)]));
  });
  check(
    balances[alice] === 15 && balances[bob] === -15,
    "a 30.00 dinner split equally leaves Alice owed 15 and Bob owing 15"
  );

  const seenByMember = await asUser(bob, async () => {
    const { rows } = await db.query(`select id from public.expenses`);
    return rows.length;
  });
  check(seenByMember === 1, "a member reads the group's expense through RLS");

  const seenByStranger = await asUser(carol, async () => {
    const g = await db.query(`select id from public.groups`);
    const e = await db.query(`select id from public.expenses`);
    return g.rows.length + e.rows.length;
  });
  check(seenByStranger === 0, "a non-member reads no groups or expenses");

  check(
    await asUser(carol, () =>
      rejects(db.query(`select * from public.get_group_balances($1)`, [groupId]))
    ),
    "a non-member cannot read a group's balances"
  );
  check(
    await asUser(bob, () =>
      rejects(
        db.query(
          `insert into public.expenses (group_id, paid_by, amount, description) values ($1, $2, 1, 'x')`,
          [groupId, bob]
        ),
        "42501" // insufficient_privilege: the grant is gone, not just blocked by RLS
      )
    ),
    "clients cannot write a table directly (writes go through the RPCs)"
  );

  // RLS alone would also turn a direct write away (with the same SQLSTATE), so
  // look at the grants themselves: the API roles hold SELECT and nothing else.
  const writable = await db.query(`
    select r.rolname || ' ' || p.priv || ' on ' || c.relname as grant_held
    from pg_class c
    cross join (values ('anon'), ('authenticated')) r(rolname)
    cross join (values ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) p(priv)
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and has_table_privilege(r.rolname, c.oid, p.priv)
  `);
  check(
    writable.rows.length === 0,
    `anon and authenticated hold no write grant on any public table${
      writable.rows.length
        ? `: ${writable.rows.slice(0, 3).map((r) => r.grant_held).join("; ")}`
        : ""
    }`
  );

  const published = await db.query(
    `select tablename from pg_publication_tables where pubname = 'supabase_realtime' order by 1`
  );
  check(
    JSON.stringify(published.rows.map((r) => r.tablename)) ===
      JSON.stringify(REALTIME_TABLES),
    `realtime publishes exactly ${REALTIME_TABLES.join(", ")}`
  );
} catch (error) {
  fail(`smoke test threw: ${error.message}`);
}

// supabase/schemas/ is documented as the source of truth and migrations are
// generated from it. Build a second database from the schema files alone and
// compare what Postgres reports, so the two cannot drift apart unnoticed.
// (The auth trigger and the realtime publication live only in migrations.)
const schemasDir = join(migrationsDir, "..", "schemas");
const SCHEMA_ORDER = [
  "01_types",
  "02_tables_core",
  "03_tables_contacts",
  "04_functions",
  "05_policies",
];

async function catalog(database) {
  const rows = async (sql) => (await database.query(sql)).rows;
  return {
    columns: (
      await rows(`select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as k, '' as v
        from information_schema.columns where table_schema = 'public'`)
    ),
    functions: await rows(`select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ') secdef=' || p.prosecdef as k,
        regexp_replace(pg_get_functiondef(p.oid), '\\s+', ' ', 'g') as v
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`),
    policies: await rows(`select tablename || '.' || policyname || ' ' || cmd as k,
        coalesce(qual, '') || ' | ' || coalesce(with_check, '') as v from pg_policies where schemaname = 'public'`),
    constraints: await rows(`select conrelid::regclass || '.' || conname as k, pg_get_constraintdef(oid) as v
        from pg_constraint where connamespace = 'public'::regnamespace`),
    indexes: await rows(`select indexdef as k, '' as v from pg_indexes where schemaname = 'public'`),
    rowSecurity: await rows(`select relname as k, relrowsecurity::text as v
        from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'`),
  };
}

try {
  const fromSchemas = new PGlite();
  await fromSchemas.exec(SUPABASE_STUBS);
  for (const name of SCHEMA_ORDER) {
    await fromSchemas.exec(readFileSync(join(schemasDir, `${name}.sql`), "utf8"));
  }
  const [built, declared] = [await catalog(db), await catalog(fromSchemas)];
  for (const kind of Object.keys(built)) {
    const mine = new Map(built[kind].map((r) => [r.k, r.v]));
    const theirs = new Map(declared[kind].map((r) => [r.k, r.v]));
    const apart = [
      ...[...mine.keys()].filter((k) => !theirs.has(k)).map((k) => `only in migrations: ${k}`),
      ...[...theirs.keys()].filter((k) => !mine.has(k)).map((k) => `only in schemas/: ${k}`),
      ...[...mine.keys()].filter((k) => theirs.has(k) && mine.get(k) !== theirs.get(k)).map((k) => `differs: ${k}`),
    ];
    check(
      apart.length === 0,
      `schemas/ and migrations agree on ${kind} (${mine.size})${apart.length ? `: ${apart.slice(0, 5).join("; ")}` : ""}`
    );
  }
} catch (error) {
  fail(`schemas/ drift check threw: ${error.message}`);
}

console.log(
  failures
    ? `\n${failures} check(s) failed.`
    : `\nAll ${files.length} migrations apply to an empty database, the smoke test passes and schemas/ matches.`
);
process.exit(failures ? 1 : 0);
