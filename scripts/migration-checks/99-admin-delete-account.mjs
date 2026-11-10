// Admin-only account deletion (database only). The whole of account deletion now
// lives in the private _delete_account(uuid); delete_my_account() is a thin wrapper
// around it for the signed-in user, and admin_delete_account(uuid) is the same call
// for an operator (service_role, SQL editor) who got an emailed request. Module 97
// proves delete_my_account still behaves as before; this one proves the two routes
// end in the same database state, that the admin route needs no JWT, who may call
// what, and the one-line summary.

const NOTHING = "nothing to delete (already deleted or unknown id)";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export default async function adminDeleteAccount({ db, asUser, signUp, check }) {
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  const errorOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.message;
    }
  };
  const codeOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.code;
    }
  };
  const json = (value) => JSON.stringify(value);
  const asRole = async (role, fn) => {
    await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role`);
    }
  };

  let seq = 0;
  const user = async (name) => {
    seq += 1;
    const email = `ada-${name.toLowerCase()}-${seq}@example.com`;
    return { id: await signUp(email, name), email, name };
  };
  const day = async (n) =>
    (await one(`select to_char((now() at time zone 'UTC')::date + $1::int, 'YYYY-MM-DD') as d`, [n])).d;
  const later = async (days) => (await one(`select (now() + make_interval(days => $1))::text as d`, [days])).d;
  const count = async (sql, params) => Number((await one(`select count(*)::int as n from (${sql}) t`, params)).n);

  const makeGroup = (creator, others, name = "Ada group") =>
    asUser(creator.id, async () =>
      (await one(`select * from public.create_group_with_members($1, $2::text[], 'USD')`, [name, others.map((u) => u.email)])).id
    );
  const shares = (users, total) => users.map((u) => ({ userId: u.id, amount: total / users.length }));
  const expense = (groupId, actor, paidBy, amount, splits, o = {}) =>
    asUser(actor.id, () =>
      one(
        `select * from public.create_expense_with_splits($1, $2, $3, $4, null, 'exact'::public.split_type, $5::jsonb, $6, 'USD', 1)`,
        [groupId, paidBy.id, amount, o.description ?? "Dinner", json(splits), o.date ?? null]
      )
    );
  const pay = (groupId, actor, from, to, amount, date = null) =>
    asUser(actor.id, () =>
      one(`select * from public.create_payment($1, $2, $3, $4, null, null, $5)`, [groupId, from.id, to.id, amount, date])
    );
  const groupSchedule = (actor, groupId, paidBy, splits, start) =>
    asUser(actor.id, () =>
      one(
        `select * from public.create_recurring_schedule($1, null, $2, 20, 'Rent', null, 'exact'::public.split_type, $3::jsonb,
           'USD', 1, $4::date, 'UTC', 'daily', null, null)`,
        [groupId, paidBy.id, json(splits), start]
      )
    );
  const contactSchedule = (actor, other, paidBy, splits, start, currency) =>
    asUser(actor.id, () =>
      one(
        `select * from public.create_recurring_schedule(null, $1, $2, 20, 'Gym', null, 'exact'::public.split_type, $3::jsonb,
           $5, 1, $4::date, 'UTC', 'daily', null, null)`,
        [other.id, paidBy.id, json(splits), start, currency]
      )
    );
  const contactExpense = (actor, other, paidBy, amount, splits, o = {}) =>
    asUser(actor.id, () =>
      one(
        `select * from public.create_contact_expense_with_splits($1, $2, $3, 'Lunch', null, 'exact'::public.split_type, $4::jsonb, $5, $6, 1)`,
        [other.id, paidBy.id, amount, json(splits), o.date ?? null, o.currency ?? "USD"]
      )
    );
  const contactPay = (actor, other, from, to, amount, date = null) =>
    asUser(actor.id, () =>
      one(`select * from public.create_contact_payment($1, $2, $3, $4, null, null, $5)`, [other.id, from.id, to.id, amount, date])
    );
  const befriend = (a, b) => db.query(`select public.create_contact_pair($1, $2)`, [a.id, b.id]);
  const groupBalances = (groupId, viewer) =>
    asUser(viewer.id, () =>
      q(`select user_id, full_name, balance::text as balance from public.get_group_balances($1) order by user_id`, [groupId])
    );
  const contactBalance = async (viewer, other) =>
    (await asUser(viewer.id, () => one(`select public.get_contact_balance($1)::text as b`, [other.id]))).b;
  const profile = (u) => one(`select * from public.profiles where id = $1`, [u.id]);
  const authUsers = (u) => count(`select 1 from auth.users where id = $1`, [u.id]);
  const admin = (id) => one(`select public.admin_delete_account($1) as r`, [id]).then((r) => r.r);
  const mine = (u) => asUser(u.id, () => db.query(`select public.delete_my_account()`));

  const TABLES = [
    "profiles", "groups", "group_members", "expenses", "expense_splits", "payments",
    "group_simplify_debts_events", "recurring_schedules", "contacts", "contact_expenses",
    "contact_expense_splits", "contact_payments", "contact_pair_settings", "contact_requests",
  ];
  const snapshot = async () => {
    const out = {};
    for (const t of TABLES) {
      out[t] = (await one(`select coalesce(md5(string_agg(t::text, ',' order by t::text)), '') as h from public.${t} t`)).h;
    }
    out.auth = (await one(`select coalesce(md5(string_agg(id::text, ',' order by id::text)), '') as h from auth.users`)).h;
    return json(out);
  };

  // ---- Who may call what ------------------------------------------------------------
  const procs = await q(`
    select p.proname, p.oid::regprocedure::text as sig, p.prosecdef, p.prorettype::regtype::text as ret,
      coalesce(p.proconfig::text, '') as config,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authed,
      has_function_privilege('service_role', p.oid, 'execute') as service,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('_delete_account', 'admin_delete_account', 'delete_my_account')
    order by 1
  `);
  const fn = (name) => procs.find((r) => r.proname === name);
  check(procs.length === 3, "exactly one _delete_account, one admin_delete_account and one delete_my_account exist");
  const priv = fn("_delete_account");
  check(
    priv?.sig === "_delete_account(uuid)" && priv.ret === "boolean" && priv.prosecdef && priv.config.includes("search_path=public, pg_temp"),
    "_delete_account(uuid) returns boolean, SECURITY DEFINER, search_path pinned to public, pg_temp"
  );
  check(!priv?.anon && !priv?.authed && !priv?.public_exec, "_delete_account is not executable by anon, authenticated or PUBLIC");
  const adm = fn("admin_delete_account");
  check(
    adm?.sig === "admin_delete_account(uuid)" && adm.ret === "text" && adm.prosecdef && adm.config.includes("search_path=public, pg_temp"),
    "admin_delete_account(uuid) returns text, SECURITY DEFINER, search_path pinned to public, pg_temp"
  );
  check(
    adm?.service && !adm.anon && !adm.authed && !adm.public_exec,
    "admin_delete_account is executable by service_role and not by anon, authenticated or PUBLIC"
  );
  const wrapper = fn("delete_my_account");
  check(
    wrapper?.sig === "delete_my_account()" && wrapper.ret === "void" && wrapper.prosecdef && wrapper.config.includes("search_path=public, pg_temp") &&
      wrapper.authed && !wrapper.anon && !wrapper.public_exec,
    "delete_my_account() keeps its contract: no arguments, void, SECURITY DEFINER, authenticated only"
  );
  const wrapperDef = (await one(`select regexp_replace(pg_get_functiondef('public.delete_my_account()'::regprocedure), '\\s+', ' ', 'g') as d`)).d;
  check(
    /raise exception 'Not authenticated'/.test(wrapperDef) && /perform public\._delete_account\(v_uid\)/.test(wrapperDef) && !/delete from/.test(wrapperDef),
    "delete_my_account is a thin wrapper: 'Not authenticated', then _delete_account(auth.uid()), no deletion logic of its own"
  );
  const stray = await q(`
    select p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and left(p.proname, 1) <> '_'
      and not (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))
    order by 1
  `);
  check(
    json(stray.map((r) => r.sig)) === json(["admin_delete_account(uuid)"]),
    `admin_delete_account is the only function outside the _ rule that clients cannot execute (found: ${stray.map((r) => r.sig).join("; ")})`
  );

  const victim = await user("Acl");
  const bystander = await user("Bystander");
  const aclCalls = [
    ["anon", () => asRole("anon", () => db.query(`select public.admin_delete_account($1)`, [victim.id]))],
    ["anon (_delete_account)", () => asRole("anon", () => db.query(`select public._delete_account($1)`, [victim.id]))],
    ["authenticated, another user's id", () => asUser(bystander.id, () => db.query(`select public.admin_delete_account($1)`, [victim.id]))],
    ["authenticated, their own id", () => asUser(victim.id, () => db.query(`select public.admin_delete_account($1)`, [victim.id]))],
    ["authenticated (_delete_account), their own id", () => asUser(victim.id, () => db.query(`select public._delete_account($1)`, [victim.id]))],
  ];
  for (const [who, run] of aclCalls) {
    check((await codeOf(run())) === "42501", `${who} calling it is permission denied (42501)`);
  }
  check((await profile(victim)).deleted_at === null && (await authUsers(victim)) === 1, "the refused calls changed nothing, not even for the caller's own id");
  check(
    (await asRole("service_role", () => one(`select public.admin_delete_account(gen_random_uuid()) as r`))).r === NOTHING,
    "service_role can call admin_delete_account"
  );

  // ---- Null id, unknown id ------------------------------------------------------------
  check((await errorOf(admin(null))) === "User id is required", "a null id raises 'User id is required'");
  {
    const before = await snapshot();
    const unknown = await admin("00000000-0000-4000-8000-0000000000cc");
    check(unknown === NOTHING, `an unknown id answers '${NOTHING}'`);
    check((await snapshot()) === before, "and changes nothing");
  }

  check(
    (await one(`select public._delete_account(null) as r`)).r === false,
    "_delete_account(null) does nothing and says so (false), it does not raise"
  );
  check(
    (await one(`select public._delete_account('00000000-0000-4000-8000-0000000000dd') as r`)).r === false,
    "_delete_account of an unknown id is false"
  );

  // ---- The twin scenario ----------------------------------------------------------------
  await db.exec(`
    create table auth.audit_log_entries (
      id uuid primary key default gen_random_uuid(),
      payload json,
      created_at timestamptz default now(),
      ip_address text default ''
    )
  `);
  const scenario = async (tag) => {
    const [s, a, b, c, d, e] = [await user("Sam"), await user("Ann"), await user("Bob"), await user("Cat"), await user("Dee"), await user("Eli")];
    await befriend(s, a);
    await befriend(s, b);
    await befriend(s, c);
    await asUser(s.id, () => db.query(`select public.set_contact_currency($1, 'EUR')`, [a.id]));
    // contact a: open balance, a future row each way, a running schedule
    await contactExpense(s, a, s, 40, shares([s, a], 40), { currency: "EUR" });
    await contactExpense(s, a, s, 10, shares([s, a], 10), { currency: "EUR", date: await later(5) });
    await contactPay(a, s, a, s, 5, await later(5));
    await contactSchedule(s, a, s, shares([s, a], 20), await day(-1), "EUR");
    // contact b: settled to zero, with a ledger. contact c: nothing but the contact
    await contactExpense(b, s, b, 30, shares([s, b], 30));
    await contactPay(s, b, s, b, 15);
    // requests both ways
    await asUser(s.id, () => db.query(`select public.send_contact_request($1)`, [d.email]));
    await asUser(e.id, () => db.query(`select public.send_contact_request($1)`, [s.email]));
    // groups: g1 (S created it, open debt, future rows, schedules), g2 (solo), g3 (quiet)
    const g1 = await makeGroup(s, [a, b], "Trip");
    // Members added together share a joined_at and the hand-over then falls to the user id, which is
    // random: fix the order so the longest-standing member is the same in both scenarios.
    for (const [i, u] of [s, a, b].entries()) {
      await db.query(
        `update public.group_members set joined_at = now() - make_interval(mins => $3) where group_id = $1 and user_id = $2`,
        [g1, u.id, 1000 - i]
      );
    }
    await expense(g1, s, s, 90, shares([s, a, b], 90));
    await expense(g1, a, a, 30, shares([s, a, b], 30));
    await pay(g1, b, b, a, 5);
    await expense(g1, a, a, 12, [{ userId: s.id, amount: 4 }, { userId: a.id, amount: 8 }], { date: await later(10), description: "Future with S" });
    await expense(g1, a, a, 6, [{ userId: a.id, amount: 3 }, { userId: b.id, amount: 3 }], { date: await later(10), description: "Future without S" });
    await pay(g1, s, s, a, 3, await later(10));
    await groupSchedule(s, g1, s, [{ userId: s.id, amount: 10 }, { userId: a.id, amount: 10 }], await day(-2));
    await groupSchedule(a, g1, a, [{ userId: a.id, amount: 10 }, { userId: s.id, amount: 10 }], await day(-1));
    await groupSchedule(a, g1, a, [{ userId: a.id, amount: 10 }, { userId: b.id, amount: 10 }], await day(-1));
    const g2 = await makeGroup(s, [], "Alone");
    await expense(g2, s, s, 10, [{ userId: s.id, amount: 10 }]);
    const g3 = await makeGroup(a, [s], "Quiet");
    // audit log rows: two by actor_id, one by traits.user_id, and two that are not S's
    const row = (label, payload) =>
      db.query(`insert into auth.audit_log_entries (id, payload) values (gen_random_uuid(), $1::json)`, [json({ label, tag, ...payload })]);
    await row("login", { actor_id: s.id, actor_username: s.email, action: "login" });
    await row("token", { actor_id: s.id, actor_username: s.email, action: "token_refreshed" });
    await row("deleted", { action: "user_deleted", traits: { user_id: s.id } });
    await row("other", { actor_id: a.id, actor_username: a.email, action: "login" });
    await row("unrelated", { action: "token_revoked" });
    return { tag, s, a, b, c, d, e, g1, g2, g3, users: [s, a, b, c, d, e], groups: [g1, g2, g3] };
  };

  // What the deleted user's neighbourhood looks like, with ids replaced by labels so two
  // scenarios built the same way can be compared.
  const fingerprint = async (sc) => {
    const names = { s: sc.s, a: sc.a, b: sc.b, c: sc.c, d: sc.d, e: sc.e };
    const labels = new Map(Object.entries(names).map(([k, u]) => [u.id, k]));
    labels.set(sc.g1, "g1");
    labels.set(sc.g2, "g2");
    labels.set(sc.g3, "g3");
    const lab = (id) => (id == null ? null : labels.get(id) ?? "#");
    const pair = (lo, hi) => [lab(lo), lab(hi)].sort().join("+");
    const U = sc.users.map((u) => u.id);
    const G = sc.groups;
    const lines = [];
    const add = (table, obj) => lines.push(`${table} ${json(obj)}`);
    for (const r of await q(`select id, full_name, avatar_url, deleted_at is not null as tomb from public.profiles where id = any($1::uuid[])`, [U]))
      add("profile", { u: lab(r.id), name: r.full_name, avatar: r.avatar_url, tomb: r.tomb });
    for (const r of await q(`select id from auth.users where id = any($1::uuid[])`, [U])) add("auth", { u: lab(r.id) });
    for (const r of await q(`select id, created_by, name from public.groups where id = any($1::uuid[])`, [G]))
      add("group", { g: lab(r.id), by: lab(r.created_by), name: r.name });
    for (const r of await q(`select group_id, user_id from public.group_members where group_id = any($1::uuid[]) or user_id = any($2::uuid[])`, [G, U]))
      add("member", { g: lab(r.group_id), u: lab(r.user_id) });
    for (const r of await q(
      `select e.group_id, e.paid_by, e.amount::text, e.base_amount::text as base, e.description, e.date > now() as future,
         e.schedule_id is not null as sched, e.hand_edited, es.user_id as split_user, es.amount::text as split_amount
       from public.expenses e left join public.expense_splits es on es.expense_id = e.id where e.group_id = any($1::uuid[])`, [G]))
      add("expense", { g: lab(r.group_id), by: lab(r.paid_by), amt: r.amount, base: r.base, d: r.description, future: r.future, sched: r.sched, hand: r.hand_edited, su: lab(r.split_user), sa: r.split_amount });
    for (const r of await q(`select group_id, paid_by, paid_to, amount::text, date > now() as future from public.payments where group_id = any($1::uuid[])`, [G]))
      add("payment", { g: lab(r.group_id), from: lab(r.paid_by), to: lab(r.paid_to), amt: r.amount, future: r.future });
    for (const r of await q(
      `select ce.user_lo, ce.user_hi, ce.paid_by, ce.amount::text, ce.base_amount::text as base, ce.description, ce.date > now() as future,
         ce.schedule_id is not null as sched, ces.user_id as split_user, ces.amount::text as split_amount
       from public.contact_expenses ce left join public.contact_expense_splits ces on ces.expense_id = ce.id
       where ce.user_lo = any($1::uuid[]) and ce.user_hi = any($1::uuid[])`, [U]))
      add("contact_expense", { pair: pair(r.user_lo, r.user_hi), by: lab(r.paid_by), amt: r.amount, base: r.base, d: r.description, future: r.future, sched: r.sched, su: lab(r.split_user), sa: r.split_amount });
    for (const r of await q(
      `select user_lo, user_hi, paid_by, paid_to, amount::text, date > now() as future from public.contact_payments
       where user_lo = any($1::uuid[]) and user_hi = any($1::uuid[])`, [U]))
      add("contact_payment", { pair: pair(r.user_lo, r.user_hi), from: lab(r.paid_by), to: lab(r.paid_to), amt: r.amount, future: r.future });
    for (const r of await q(`select owner_id, contact_user_id from public.contacts where owner_id = any($1::uuid[]) and contact_user_id = any($1::uuid[])`, [U]))
      add("contact", { owner: lab(r.owner_id), other: lab(r.contact_user_id) });
    for (const r of await q(`select requester_id, recipient_id, status from public.contact_requests where requester_id = any($1::uuid[]) and recipient_id = any($1::uuid[])`, [U]))
      add("request", { from: lab(r.requester_id), to: lab(r.recipient_id), status: r.status });
    for (const r of await q(`select user_lo, user_hi, currency from public.contact_pair_settings where user_lo = any($1::uuid[]) and user_hi = any($1::uuid[])`, [U]))
      add("setting", { pair: pair(r.user_lo, r.user_hi), currency: r.currency });
    for (const r of await q(
      `select kind, group_id, user_lo, user_hi, paid_by, created_by, description, amount::text, stopped_at is not null as stopped, stop_reason, last_error
       from public.recurring_schedules where paid_by = any($1::uuid[]) or created_by = any($1::uuid[])`, [U]))
      add("schedule", { kind: r.kind, g: lab(r.group_id), pair: r.user_lo ? pair(r.user_lo, r.user_hi) : null, by: lab(r.paid_by), created: lab(r.created_by), d: r.description, amt: r.amount, stopped: r.stopped, reason: r.stop_reason, err: r.last_error });
    for (const r of await q(`select payload->>'label' as label from auth.audit_log_entries where payload->>'tag' = $1`, [sc.tag]))
      add("audit", { label: r.label });
    return lines.sort();
  };

  const twinA = await scenario("A");
  const twinB = await scenario("B");
  const fingerprintBefore = [await fingerprint(twinA), await fingerprint(twinB)];
  check(
    json(fingerprintBefore[0]) === json(fingerprintBefore[1]) && fingerprintBefore[0].length > 40,
    `setup: the two scenarios are identical once ids are replaced by labels (${fingerprintBefore[0].length} lines each)`
  );
  check(
    (await groupBalances(twinA.g1, twinA.a)).length === 3 && Number(await contactBalance(twinA.a, twinA.s)) !== 0 &&
      Number(await contactBalance(twinA.b, twinA.s)) === 0,
    "setup: an open group debt, a contact with an open balance and a settled one"
  );

  // The scope of the scenario, measured from the outside, for the expected counts.
  const scopeCounts = async (sc) => {
    const U = sc.users.map((u) => u.id);
    return {
      future:
        (await count(`select 1 from public.expenses where group_id = any($1::uuid[]) and date > now()`, [sc.groups])) +
        (await count(`select 1 from public.payments where group_id = any($1::uuid[]) and date > now()`, [sc.groups])) +
        (await count(`select 1 from public.contact_expenses where user_lo = any($1::uuid[]) and user_hi = any($1::uuid[]) and date > now()`, [U])) +
        (await count(`select 1 from public.contact_payments where user_lo = any($1::uuid[]) and user_hi = any($1::uuid[]) and date > now()`, [U])),
      running: await count(`select 1 from public.recurring_schedules where (paid_by = any($1::uuid[]) or created_by = any($1::uuid[])) and stopped_at is null`, [U]),
      requests: await count(`select 1 from public.contact_requests where requester_id = $1 or recipient_id = $1`, [sc.s.id]),
      audit: await count(`select 1 from auth.audit_log_entries where payload->>'tag' = $1 and (payload->>'actor_id' = $2 or payload->'traits'->>'user_id' = $2)`, [sc.tag, sc.s.id]),
    };
  };
  const beforeB = await scopeCounts(twinB);
  const balancesBeforeB = {
    g1: (await groupBalances(twinB.g1, twinB.a)).filter((r) => r.user_id !== twinB.s.id),
    g1Ghost: (await groupBalances(twinB.g1, twinB.a)).find((r) => r.user_id === twinB.s.id).balance,
    g3: (await groupBalances(twinB.g3, twinB.a)).filter((r) => r.user_id !== twinB.s.id),
    contactA: await contactBalance(twinB.a, twinB.s),
    contactB: await contactBalance(twinB.b, twinB.s),
  };

  // Twin A: the user deletes their own account.
  await mine(twinA.s);

  // Twin B: an operator, as the database owner, with NO jwt claims, and with auth.uid()
  // made to fail loudly so that any use of it by the deletion path would show.
  const authUidDef = (await one(`select pg_get_functiondef('auth.uid()'::regprocedure) as d`)).d;
  await db.exec(`
    create or replace function auth.uid() returns uuid language plpgsql as
      $$ begin raise exception 'auth.uid() was called by the admin path'; end $$;
  `);
  let summary;
  let adminError = null;
  try {
    summary = await admin(twinB.s.id);
  } catch (error) {
    adminError = error.message;
  } finally {
    await db.exec(authUidDef);
  }
  check(adminError === null, `admin_delete_account runs with no JWT and never calls auth.uid() (${adminError ?? "no error"})`);
  check(
    (await one(`select pg_get_functiondef('auth.uid()'::regprocedure) as d`)).d === authUidDef,
    "setup: auth.uid() is back as it was"
  );

  // ---- Same promise, same state ---------------------------------------------------------
  const fpA = await fingerprint(twinA);
  const fpB = await fingerprint(twinB);
  check(json(fpA) === json(fpB), "the admin route leaves the same database state as delete_my_account (per-table rows and key columns, ids normalised)");
  if (json(fpA) !== json(fpB)) {
    console.error("A only:", fpA.filter((l) => !fpB.includes(l)).slice(0, 5), "\nB only:", fpB.filter((l) => !fpA.includes(l)).slice(0, 5));
  }
  check(
    fpA.some((l) => l.startsWith("profile") && l.includes('"u":"s"') && l.includes('"name":"Deleted user"') && l.includes('"tomb":true')) &&
      !fpA.some((l) => l.startsWith("auth") && l.includes('"u":"s"')) &&
      fpA.some((l) => l.startsWith("group ") && l.includes('"g":"g1"')) && !fpA.some((l) => l.startsWith("group ") && l.includes('"g":"g2"')) &&
      fpA.filter((l) => l.startsWith("audit")).length === 2,
    "and that state is a real deletion: tombstone, no auth user, the open-debt group kept, the solo group gone, the audit rows gone"
  );

  // ---- Others are not affected ----------------------------------------------------------
  const afterB = {
    g1: (await groupBalances(twinB.g1, twinB.a)).filter((r) => r.user_id !== twinB.s.id),
    g1Ghost: (await groupBalances(twinB.g1, twinB.a)).find((r) => r.user_id === twinB.s.id)?.balance,
    g3: (await groupBalances(twinB.g3, twinB.a)).filter((r) => r.user_id !== twinB.s.id),
    contactA: await contactBalance(twinB.a, twinB.s),
    contactB: await contactBalance(twinB.b, twinB.s),
  };
  check(json(afterB.g1) === json(balancesBeforeB.g1) && afterB.g1Ghost === balancesBeforeB.g1Ghost, "admin route: the other members' balances in the trip group, and the ghost's, are identical before and after");
  check(json(afterB.g3) === json(balancesBeforeB.g3), "admin route: the other member's balances in the quiet group are identical before and after");
  check(afterB.contactA === balancesBeforeB.contactA && afterB.contactB === balancesBeforeB.contactB, "admin route: the contact balances (open and settled) are identical before and after");

  // ---- The summary ----------------------------------------------------------------------
  const afterScope = await scopeCounts(twinB);
  const removedFuture = beforeB.future - afterScope.future;
  check(removedFuture >= 4, `setup: the scenario had future-dated rows to remove (${removedFuture})`);
  const expected =
    `deleted: profile tombstoned; auth user removed; groups left 2 of 3 (1 deleted); schedules stopped ${beforeB.running - afterScope.running}; ` +
    `future rows removed ${removedFuture}; contact requests removed ${beforeB.requests}; contacts removed 2 of 3 pairs; audit rows removed ${beforeB.audit}`;
  check(summary === expected, `the summary has the counts of the scenario (got: ${summary}; expected: ${expected})`);
  check(beforeB.running - afterScope.running === 3 && beforeB.requests === 2 && beforeB.audit === 3, "and those counts are the ones the scenario was built to have (3 schedules, 2 requests, 3 audit rows)");
  const known = [twinB.s, twinB.a, twinB.b, twinB.c, twinB.d, twinB.e].flatMap((u) => [u.id, u.email, u.name]);
  check(
    summary.split("\n").length === 1 && !UUID.test(summary) && !/@/.test(summary) && !known.some((v) => summary.includes(v)),
    "it is one line and holds no uuid, email address or name"
  );

  check(
    (await one(`select coalesce(current_setting('app.delete_account_stats', true), '') as v`)).v === "",
    "the counts do not outlive the transaction (the setting is empty again after the call)"
  );

  // ---- Idempotent: a second run ---------------------------------------------------------
  {
    const before = await snapshot();
    check((await admin(twinB.s.id)) === NOTHING, `a second run answers '${NOTHING}'`);
    check((await snapshot()) === before, "and changes nothing");
    check((await admin(twinA.s.id)) === NOTHING, "the account deleted by the user is 'nothing to delete' for the operator too");
    check((await errorOf(mine(twinB.s))) === null, "and a second delete_my_account for a deleted account still returns quietly");
    check((await snapshot()) === before, "without changing anything");
  }

  // ---- Odd states -----------------------------------------------------------------------
  {
    // An auth user with no profile: the login goes, there is no profile to tombstone.
    const noProfile = await user("Noprofile");
    await db.query(`delete from public.profiles where id = $1`, [noProfile.id]);
    const text = await admin(noProfile.id);
    check(/^deleted: no profile; auth user removed; /.test(text) && (await authUsers(noProfile)) === 0, `an auth user with no profile is deleted (${text})`);
    check((await admin(noProfile.id)) === NOTHING, "and a second run does nothing");

    // A live profile with no auth user: it is tombstoned and cleaned up.
    const orphanId = (await one(`insert into public.profiles (id, full_name) values (gen_random_uuid(), 'Orphan') returning id`)).id;
    const og = await makeGroup(bystander, [], "Orphans");
    await db.query(`insert into public.group_members (group_id, user_id) values ($1, $2)`, [og, orphanId]);
    check((await count(`select 1 from auth.users where id = $1`, [orphanId])) === 0, "setup: a live profile with no auth.users row, in a group");
    const orphanText = await admin(orphanId);
    check(/^deleted: profile tombstoned; no auth user; groups left 1 of 1 \(0 deleted\); /.test(orphanText), `a live profile with no auth user is tombstoned and leaves its group (${orphanText})`);
    const o = await one(`select full_name, deleted_at is not null as tomb from public.profiles where id = $1`, [orphanId]);
    check(o.full_name === "Deleted user" && o.tomb, "its profile reads 'Deleted user' with deleted_at set");
    check((await admin(orphanId)) === NOTHING, "and a second run does nothing");

    // A tombstone whose auth user is still there (marked by hand).
    const half = await user("Half");
    await db.query(`update public.profiles set deleted_at = now(), full_name = 'Deleted user' where id = $1`, [half.id]);
    const halfText = await admin(half.id);
    check(/^deleted: profile was already a tombstone; auth user removed; /.test(halfText) && (await authUsers(half)) === 0, `a tombstone whose auth user is still there gets the auth user deleted (${halfText})`);
  }

  // ---- The audit log: refused, and absent --------------------------------------------------
  {
    const refused = await user("Refused");
    await db.exec(`
      create function auth.tmp_refuse_audit() returns trigger language plpgsql as
        $$ begin raise exception 'audit log is read only'; end $$;
      create trigger tmp_refuse before delete on auth.audit_log_entries for each row execute function auth.tmp_refuse_audit();
    `);
    await db.query(`insert into auth.audit_log_entries (id, payload) values (gen_random_uuid(), $1::json)`, [json({ label: "refused", tag: "R", actor_id: refused.id })]);
    let text;
    try {
      text = await admin(refused.id);
    } finally {
      await db.exec(`drop trigger tmp_refuse on auth.audit_log_entries; drop function auth.tmp_refuse_audit()`);
    }
    check(
      /audit rows removed 0 \(cleanup refused\)$/.test(text) && (await authUsers(refused)) === 0,
      `a refusal by the audit log does not stop the deletion and the summary says so (${text})`
    );
  }
  await db.exec(`drop table auth.audit_log_entries`);
  {
    const noTable = await user("Notable");
    const text = await admin(noTable.id);
    check(/audit rows removed 0 \(no audit table\)$/.test(text), `with no audit table the summary says so (${text})`);
  }

  // ---- A failure rolls everything back, for the admin route too -------------------------------
  {
    const [z, w] = [await user("Zed"), await user("Wren")];
    await befriend(z, w);
    const gz = await makeGroup(z, [w], "Rollback");
    await expense(gz, z, z, 20, shares([z, w], 20));
    await groupSchedule(z, gz, z, shares([z, w], 20), await day(0));
    const snap = await snapshot();
    await db.exec(`
      create function auth.tmp_block_delete() returns trigger language plpgsql as
        $$ begin raise exception 'forced failure'; end $$;
      create trigger tmp_block before delete on auth.users for each row execute function auth.tmp_block_delete();
    `);
    let failed;
    try {
      failed = await errorOf(admin(z.id));
    } finally {
      await db.exec(`drop trigger tmp_block on auth.users; drop function auth.tmp_block_delete()`);
    }
    check(failed === "forced failure", `an error inside the deletion reaches the operator (got: ${failed})`);
    check((await snapshot()) === snap, "and nothing is changed");
  }
}
