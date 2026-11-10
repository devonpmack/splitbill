// Account deletion, piece 3: public.delete_my_account() (database only).
// One transaction: tombstone the profile, stop the schedules that involve the
// caller, remove future-dated rows that involve them, take them out of every group
// (piece 2's helper), clean up contacts, then delete the auth user. Also an
// AFTER DELETE trigger on auth.users so a raw delete (dashboard, SQL) leaves a
// proper tombstone.

export default async function deleteMyAccount({ db, asUser, signUp, check }) {
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
  const asAnon = async (fn) => {
    await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role`);
    }
  };

  let seq = 0;
  const user = async (name) => {
    seq += 1;
    const email = `dma-${name.toLowerCase()}-${seq}@example.com`;
    return { id: await signUp(email, name), email, name };
  };
  const day = async (n) =>
    (await one(`select to_char((now() at time zone 'UTC')::date + $1::int, 'YYYY-MM-DD') as d`, [n])).d;
  const later = async (days) => (await one(`select (now() + make_interval(days => $1))::text as d`, [days])).d;

  const makeGroup = (creator, others, name = "Dma group") =>
    asUser(creator.id, async () =>
      (await one(`select * from public.create_group_with_members($1, $2::text[], 'USD')`, [
        name,
        others.map((u) => u.email),
      ])).id
    );
  const setJoinOrder = async (groupId, users) => {
    for (const [i, u] of users.entries()) {
      await db.query(
        `update public.group_members set joined_at = now() - make_interval(mins => $3)
          where group_id = $1 and user_id = $2`,
        [groupId, u.id, 1000 - i]
      );
    }
  };
  const equalShares = (users, total) => users.map((u) => ({ userId: u.id, amount: total / users.length }));
  const expense = (groupId, actor, paidBy, amount, splits, o = {}) =>
    asUser(actor.id, async () =>
      one(
        `select * from public.create_expense_with_splits($1, $2, $3, $4, null, 'exact'::public.split_type, $5::jsonb, $6, 'USD', 1)`,
        [groupId, paidBy.id, amount, o.description ?? "Dinner", json(splits), o.date ?? null]
      )
    );
  const pay = (groupId, actor, from, to, amount, date = null) =>
    asUser(actor.id, async () =>
      one(`select * from public.create_payment($1, $2, $3, $4, null, null, $5)`, [groupId, from.id, to.id, amount, date])
    );
  const groupSchedule = (actor, groupId, paidBy, splits, start, frequency = "daily") =>
    asUser(actor.id, async () =>
      one(
        `select * from public.create_recurring_schedule($1, null, $2, 20, 'Rent', null, 'exact'::public.split_type, $3::jsonb,
           'USD', 1, $4::date, 'UTC', $5, null, null)`,
        [groupId, paidBy.id, json(splits), start, frequency]
      )
    );
  const contactSchedule = (actor, other, paidBy, splits, start, currency = "USD") =>
    asUser(actor.id, async () =>
      one(
        `select * from public.create_recurring_schedule(null, $1, $2, 20, 'Gym', null, 'exact'::public.split_type, $3::jsonb,
           $5, 1, $4::date, 'UTC', 'daily', null, null)`,
        [other.id, paidBy.id, json(splits), start, currency]
      )
    );
  const contactExpense = (actor, other, paidBy, amount, splits, o = {}) =>
    asUser(actor.id, async () =>
      one(
        `select * from public.create_contact_expense_with_splits($1, $2, $3, $4, null, 'exact'::public.split_type, $5::jsonb, $6, $7, $8)`,
        [other.id, paidBy.id, amount, o.description ?? "Lunch", json(splits), o.date ?? null, o.currency ?? "USD", o.rate ?? 1]
      )
    );
  const contactPay = (actor, other, from, to, amount, date = null) =>
    asUser(actor.id, async () =>
      one(`select * from public.create_contact_payment($1, $2, $3, $4, null, null, $5)`, [other.id, from.id, to.id, amount, date])
    );
  const befriend = (a, b) => db.query(`select public.create_contact_pair($1, $2)`, [a.id, b.id]);

  const groupBalances = (groupId, viewer) =>
    asUser(viewer.id, () =>
      q(`select user_id, full_name, balance::text as balance from public.get_group_balances($1) order by user_id`, [groupId])
    );
  const contactBalance = async (viewer, other) =>
    (await asUser(viewer.id, () => one(`select public.get_contact_balance($1)::text as b`, [other.id]))).b;
  const count = async (sql, params) => Number((await one(`select count(*)::int as n from (${sql}) t`, params)).n);
  const isMember = async (groupId, u) =>
    (await count(`select 1 from public.group_members where group_id = $1 and user_id = $2`, [groupId, u.id])) === 1;
  const groupExists = async (groupId) => (await count(`select 1 from public.groups where id = $1`, [groupId])) === 1;
  const profile = (u) => one(`select * from public.profiles where id = $1`, [u.id]);
  const authUsers = (u) => count(`select 1 from auth.users where id = $1`, [u.id]);
  const call = (u) => asUser(u.id, () => db.query(`select public.delete_my_account()`));

  // A checksum of every table the deletion could touch, to prove a failed call
  // changed nothing.
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

  // ---- The function and its helpers: signature, ACL, one of each ---------------
  const procs = await q(`
    select p.proname, p.oid::regprocedure::text as sig, p.prosecdef, p.prorettype::regtype::text as ret,
      coalesce(p.proconfig::text, '') as config,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authed,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('delete_my_account', '_contact_pair_balance', '_stop_schedule_member_left', '_tombstone_deleted_auth_user')
    order by 1
  `);
  const fn = (name) => procs.find((r) => r.proname === name);
  check(procs.length === 4, "exactly one delete_my_account and one of each private helper exist");
  const del = fn("delete_my_account");
  check(
    del?.sig === "delete_my_account()" && del.ret === "void" && del.prosecdef && del.config.includes("search_path=public, pg_temp"),
    "delete_my_account() takes no arguments, returns void, is SECURITY DEFINER with search_path pinned to public, pg_temp"
  );
  check(del?.authed && !del.anon && !del.public_exec, "delete_my_account is executable by authenticated only (not anon, not PUBLIC)");
  for (const name of ["_contact_pair_balance", "_stop_schedule_member_left", "_tombstone_deleted_auth_user"]) {
    const p = fn(name);
    check(
      p?.prosecdef && p.config.includes("search_path=public, pg_temp") && !p.anon && !p.authed && !p.public_exec,
      `${name} is SECURITY DEFINER, search_path pinned, and not executable by anon, authenticated or PUBLIC`
    );
  }
  const spare = await user("Spare");
  check(
    (await codeOf(asAnon(() => db.query(`select public.delete_my_account()`)))) === "42501",
    "anon calling delete_my_account is permission denied (42501)"
  );
  check(
    (await codeOf(asUser(spare.id, () => db.query(`select public._tombstone_deleted_auth_user()`)))) === "42501",
    "authenticated calling _tombstone_deleted_auth_user is permission denied (42501)"
  );
  check(
    (await codeOf(asUser(spare.id, () => db.query(`select public._stop_schedule_member_left($1)`, [spare.id])))) === "42501",
    "authenticated calling _stop_schedule_member_left is permission denied (42501)"
  );
  check(
    (await codeOf(asUser(spare.id, () => db.query(`select public._contact_pair_balance($1, $1)`, [spare.id])))) === "42501",
    "authenticated calling _contact_pair_balance is permission denied (42501)"
  );
  check(
    (await errorOf(db.query(`select public.delete_my_account()`))) === "Not authenticated",
    "delete_my_account with no signed-in user raises 'Not authenticated'"
  );
  check((await profile(spare)).deleted_at === null && (await authUsers(spare)) === 1, "the refused calls changed nothing");

  // ---- _contact_pair_balance equals get_contact_balance, in every pair shape ---
  {
    const [a, b] = [await user("Pa"), await user("Pb")];
    const shapes = [];
    const pair = async (label, fnSetup) => {
      const [x, y] = [await user(`${label}x`), await user(`${label}y`)];
      await befriend(x, y);
      await fnSetup(x, y);
      shapes.push([label, x, y]);
    };
    await pair("no ledger", async () => {});
    await pair("an equal split", (x, y) => contactExpense(x, y, x, 40, equalShares([x, y], 40)));
    await pair("paid by the other", (x, y) => contactExpense(x, y, y, 30, [{ userId: x.id, amount: 20 }, { userId: y.id, amount: 10 }]));
    await pair("expenses both ways and a payment", async (x, y) => {
      await contactExpense(x, y, x, 50, equalShares([x, y], 50));
      await contactExpense(y, x, y, 18, equalShares([x, y], 18));
      await contactPay(y, x, y, x, 7.5);
    });
    await pair("a payment the other way", async (x, y) => {
      await contactExpense(x, y, y, 20, equalShares([x, y], 20));
      await contactPay(x, y, x, y, 4);
      await contactPay(y, x, y, x, 1);
    });
    await pair("future-dated rows ignored", async (x, y) => {
      await contactExpense(x, y, x, 10, equalShares([x, y], 10));
      await contactExpense(x, y, x, 100, equalShares([x, y], 100), { date: await later(9) });
      await contactPay(y, x, y, x, 50, await later(9));
    });
    await pair("a foreign-currency expense", async (x, y) => {
      await asUser(x.id, () => db.query(`select public.set_contact_currency($1, 'EUR')`, [y.id]));
      await contactExpense(x, y, x, 30, equalShares([x, y], 30), { currency: "USD", rate: 0.9 });
    });
    await pair("settled to zero", async (x, y) => {
      await contactExpense(x, y, x, 40, equalShares([x, y], 40));
      await contactPay(y, x, y, x, 20);
    });
    for (const [label, x, y] of shapes) {
      for (const [viewer, other] of [[x, y], [y, x]]) {
        const helper = (await one(`select public._contact_pair_balance($1, $2)::text as b`, [viewer.id, other.id])).b;
        const real = await contactBalance(viewer, other);
        check(Number(helper) === Number(real),`_contact_pair_balance equals get_contact_balance for ${label}, ${viewer === x ? "first" : "second"} viewer (${helper} vs ${real})`);
      }
    }
    check(
      (await one(`select public._contact_pair_balance($1, $1)::text as b`, [a.id])).b === "0",
      "_contact_pair_balance of a user with themselves is 0, like get_contact_balance"
    );
    void b;
  }

  // ---- The main scenario ------------------------------------------------------------
  const alice = await user("Alice");
  const bob = await user("Bob");
  const cara = await user("Cara");
  const dan = await user("Dan");
  const eve = await user("Eve");
  const fay = await user("Fay");
  await db.query(`update public.profiles set avatar_url = 'https://example.com/alice.png' where id = $1`, [alice.id]);

  // Contacts: Bob (open balance, EUR ledger), Cara (settled, ledger stays), Dan (nothing).
  await befriend(alice, bob);
  await befriend(alice, cara);
  await befriend(alice, dan);
  await befriend(bob, cara);
  await asUser(alice.id, () => db.query(`select public.set_contact_currency($1, 'EUR')`, [bob.id]));
  await asUser(alice.id, () => db.query(`select public.set_contact_currency($1, 'GBP')`, [dan.id]));
  await contactExpense(alice, bob, alice, 40, equalShares([alice, bob], 40), { currency: "EUR" });
  const futureContactExpense = await contactExpense(alice, bob, alice, 10, equalShares([alice, bob], 10), { currency: "EUR", date: await later(5) });
  const futureContactPayment = await contactPay(bob, alice, bob, alice, 5, await later(5));
  await contactExpense(cara, alice, cara, 30, equalShares([alice, cara], 30));
  await contactPay(alice, cara, alice, cara, 15);
  const contactSched = await contactSchedule(alice, bob, alice, equalShares([alice, bob], 20), await day(-1), "EUR");
  await asUser(alice.id, () => db.query(`select public.send_contact_request($1)`, [eve.email]));
  await asUser(fay.id, () => db.query(`select public.send_contact_request($1)`, [alice.email]));
  await asUser(bob.id, () => db.query(`select public.send_contact_request($1)`, [eve.email]));

  // Groups.
  const g1 = await makeGroup(alice, [bob, cara], "Trip");
  await setJoinOrder(g1, [alice, bob, cara]);
  await expense(g1, alice, alice, 90, equalShares([alice, bob, cara], 90));
  await expense(g1, bob, bob, 30, equalShares([alice, bob, cara], 30));
  await pay(g1, cara, cara, bob, 5);
  const g1FutureExpense = await expense(g1, bob, bob, 12, [{ userId: alice.id, amount: 4 }, { userId: bob.id, amount: 8 }], { date: await later(10) });
  const g1FuturePayment = await pay(g1, alice, alice, bob, 3, await later(10));
  const s1 = await groupSchedule(alice, g1, alice, [{ userId: alice.id, amount: 10 }, { userId: bob.id, amount: 10 }], await day(-2));
  const s2 = await groupSchedule(bob, g1, bob, [{ userId: alice.id, amount: 10 }, { userId: bob.id, amount: 5 }, { userId: cara.id, amount: 5 }], await day(-1));
  const s3 = await groupSchedule(bob, g1, bob, [{ userId: bob.id, amount: 10 }, { userId: cara.id, amount: 10 }], await day(-1));
  const s4 = await groupSchedule(alice, g1, bob, [{ userId: bob.id, amount: 10 }, { userId: cara.id, amount: 10 }], await day(-1));
  const s5 = await groupSchedule(bob, g1, alice, [{ userId: bob.id, amount: 10 }, { userId: cara.id, amount: 10 }], await day(-1));
  const contactSched2 = await contactSchedule(bob, alice, bob, [{ userId: bob.id, amount: 20 }], await day(-1), "EUR");
  const g2 = await makeGroup(alice, [], "Alone");
  await expense(g2, alice, alice, 10, [{ userId: alice.id, amount: 10 }]);
  const g3 = await makeGroup(bob, [alice], "Quiet");
  const g4 = await makeGroup(bob, [alice], "Future");
  await expense(g4, bob, bob, 20, [{ userId: bob.id, amount: 20 }, { userId: alice.id, amount: 0 }]);
  const g4Future = await expense(g4, bob, bob, 10, [{ userId: bob.id, amount: 5 }, { userId: alice.id, amount: 5 }], { date: await later(10) });
  const g4ZeroShare = await expense(g4, bob, bob, 7, [{ userId: bob.id, amount: 7 }, { userId: alice.id, amount: 0 }], { date: await later(10) });
  await setJoinOrder(g1, [alice, bob, cara]);

  const futureRows = (scheduleId) =>
    count(`select 1 from public.expenses where schedule_id = $1 and date > now()`, [scheduleId]);
  const pastRows = (scheduleId) =>
    count(`select 1 from public.expenses where schedule_id = $1 and date <= now()`, [scheduleId]);
  const contactFuture = (scheduleId) =>
    count(`select 1 from public.contact_expenses where schedule_id = $1 and date > now()`, [scheduleId]);
  const contactPast = (scheduleId) =>
    count(`select 1 from public.contact_expenses where schedule_id = $1 and date <= now()`, [scheduleId]);
  const scheduleState = (id) => one(`select stopped_at is not null as stopped, stop_reason from public.recurring_schedules where id = $1`, [id]);

  const before = {
    g1Bob: await groupBalances(g1, bob),
    g1Cara: await groupBalances(g1, cara),
    g3Bob: await groupBalances(g3, bob),
    g4Bob: await groupBalances(g4, bob),
    contactBob: await contactBalance(bob, alice),
    contactCara: await contactBalance(cara, alice),
    s1Past: await pastRows(s1.id),
    s2Past: await pastRows(s2.id),
    s4Past: await pastRows(s4.id),
    s5Past: await pastRows(s5.id),
    contactSched2Past: await contactPast(contactSched2.id),
    s3Future: await futureRows(s3.id),
    s3Past: await pastRows(s3.id),
    contactSchedPast: await contactPast(contactSched.id),
    pastExpenses: await count(`select 1 from public.expenses where date <= now() and group_id <> $1`, [g2]),
    pastContactExpenses: await count(`select 1 from public.contact_expenses where date <= now()`),
    pastPayments: await count(`select 1 from public.payments where date <= now()`),
    pastContactPayments: await count(`select 1 from public.contact_payments where date <= now()`),
  };
  const aliceG1Before = Number(before.g1Bob.find((r) => r.user_id === alice.id).balance);
  check(Math.abs(aliceG1Before) > 0.5, `setup: Alice has an open balance in the trip group (${aliceG1Before})`);
  check(Number(before.contactBob) !== 0 && Number(before.contactCara) === 0, `setup: Bob owes Alice ${before.contactBob} (open), Cara and Alice are settled`);
  check(
    (await futureRows(s1.id)) > 0 && (await futureRows(s2.id)) > 0 && (await futureRows(s4.id)) > 0 && (await futureRows(s5.id)) > 0 &&
      (await contactFuture(contactSched.id)) > 0 && (await contactFuture(contactSched2.id)) > 0 && before.s3Future > 0 && before.s1Past > 0 && before.contactSchedPast > 0,
    "setup: the schedules have both past and pending rows"
  );

  await db.exec(`
    create table public.tmp_seen (id uuid, deleted_at timestamptz, full_name text, avatar_url text);
    create function auth.tmp_record() returns trigger language plpgsql as
      $$ begin insert into public.tmp_seen select id, deleted_at, full_name, avatar_url from public.profiles where id = old.id; return old; end $$;
    create trigger tmp_record before delete on auth.users for each row execute function auth.tmp_record();
  `);
  try {
    await call(alice);
  } finally {
    await db.exec(`drop trigger tmp_record on auth.users; drop function auth.tmp_record()`);
  }
  const seen = await one(`select * from public.tmp_seen where id = $1`, [alice.id]);
  await db.exec(`drop table public.tmp_seen`);
  check(
    seen && seen.deleted_at !== null && seen.full_name === "Deleted user" && seen.avatar_url === null,
    "the profile is already a tombstone when the auth user is deleted (tombstoned first, not by the trigger)"
  );

  // Profile and auth user.
  const gone = await profile(alice);
  check(gone.full_name === "Deleted user" && gone.avatar_url === null && gone.deleted_at !== null, "the profile is a tombstone: 'Deleted user', no avatar, deleted_at set");
  check((await authUsers(alice)) === 0, "the auth.users row is gone");
  check(
    (await asUser(bob.id, () => q(`select * from public.check_emails_registered($1::text[])`, [[alice.email, cara.email]]))).map((r) => r.email).join() === cara.email,
    "check_emails_registered no longer finds the deleted email (and still finds a live one)"
  );
  check(
    (await asUser(bob.id, async () => (await one(`select public.check_group_member_email($1, $2) as r`, [g1, alice.email])).r)) === "not_registered",
    "check_group_member_email reports the deleted email as not registered"
  );

  // Groups.
  const g1After = await groupBalances(g1, bob);
  check(
    json(g1After.filter((r) => r.user_id !== alice.id)) === json(before.g1Bob.filter((r) => r.user_id !== alice.id)) &&
      json(await groupBalances(g1, cara)) === json(g1After),
    "open debt did not block, and the other members' balances in the trip group are identical before and after"
  );
  const aliceGhost = g1After.find((r) => r.user_id === alice.id);
  check(
    aliceGhost && aliceGhost.balance === before.g1Bob.find((r) => r.user_id === alice.id).balance && aliceGhost.full_name === "Deleted user",
    "the deleted member stays in the trip group as a ghost with the same balance, named 'Deleted user'"
  );
  check((await one(`select created_by from public.groups where id = $1`, [g1])).created_by === bob.id, "the group they created goes to the longest-standing live member");
  check(!(await groupExists(g2)), "a group where they were the only member is deleted");
  check((await groupExists(g3)) && !(await isMember(g3, alice)), "a quiet group with a zero balance loses the member and stays");
  check(
    (await groupExists(g4)) && !(await isMember(g4, alice)) && (await count(`select 1 from public.expenses where id = $1`, [g4Future.id])) === 0,
    "a zero-balance member whose only tie was a future-dated expense: the row is removed and so is the membership"
  );
  check(
    (await count(`select 1 from public.expenses where id = $1`, [g4ZeroShare.id])) === 1,
    "a future-dated expense where they have a zero share is not 'involving' them and stays"
  );
  check(json(await groupBalances(g3, bob)) === json(before.g3Bob.filter((r) => r.user_id !== alice.id)), "other members' balances in the quiet group are unchanged");
  check(json(await groupBalances(g4, bob)) === json(before.g4Bob.filter((r) => r.user_id !== alice.id)), "other members' balances in the future-row group are unchanged");

  // Schedules and future rows.
  for (const [label, id] of [["group schedule they created and pay", s1.id], ["schedule where they are only in the splits", s2.id], ["schedule they only created", s4.id], ["schedule where they are only the payer", s5.id], ["contact schedule", contactSched.id], ["contact schedule they are neither payer, creator nor in the splits of", contactSched2.id]]) {
    const s = await scheduleState(id);
    check(s.stopped && s.stop_reason === "member left", `the ${label} is stopped as 'member left'`);
  }
  check((await scheduleState(s3.id)).stopped === false, "a schedule that does not involve them keeps running");
  check((await futureRows(s3.id)) === before.s3Future && (await pastRows(s3.id)) === before.s3Past, "its pending and past rows are untouched");
  check(
    (await futureRows(s1.id)) === 0 && (await futureRows(s2.id)) === 0 && (await futureRows(s4.id)) === 0 && (await futureRows(s5.id)) === 0 &&
      (await contactFuture(contactSched.id)) === 0 && (await contactFuture(contactSched2.id)) === 0,
    "the pending rows of every stopped schedule are removed"
  );
  check(
    (await pastRows(s1.id)) === before.s1Past && (await pastRows(s2.id)) === before.s2Past && (await pastRows(s4.id)) === before.s4Past && (await pastRows(s5.id)) === before.s5Past &&
      (await contactPast(contactSched2.id)) === before.contactSched2Past &&
      (await contactPast(contactSched.id)) === before.contactSchedPast,
    "the past rows of those schedules stay"
  );
  check(
    (await count(`select 1 from public.expenses where id = $1`, [g1FutureExpense.id])) === 0 &&
      (await count(`select 1 from public.payments where id = $1`, [g1FuturePayment.id])) === 0 &&
      (await count(`select 1 from public.contact_expenses where id = $1`, [futureContactExpense.id])) === 0 &&
      (await count(`select 1 from public.contact_payments where id = $1`, [futureContactPayment.id])) === 0,
    "future-dated expenses and payments they took part in (group and contact, any origin) are removed"
  );
  check(
    (await count(`select 1 from public.expenses where date <= now() and group_id <> $1`, [g2])) === before.pastExpenses &&
      (await count(`select 1 from public.contact_expenses where date <= now()`)) === before.pastContactExpenses &&
      (await count(`select 1 from public.payments where date <= now()`)) === before.pastPayments &&
      (await count(`select 1 from public.contact_payments where date <= now()`)) === before.pastContactPayments,
    "no past expense or payment, group or contact, is removed (apart from the deleted solo group's own)"
  );

  // Contacts.
  const contactRow = (owner, contactUser) =>
    count(`select 1 from public.contacts where owner_id = $1 and contact_user_id = $2`, [owner.id, contactUser.id]);
  check((await contactRow(alice, cara)) === 0 && (await contactRow(cara, alice)) === 0, "a pair with a zero balance loses both contacts rows");
  check((await contactRow(alice, dan)) === 0 && (await contactRow(dan, alice)) === 0, "a pair with no ledger loses both contacts rows");
  check((await contactRow(alice, bob)) === 0 && (await contactRow(bob, alice)) === 1, "a pair with an open balance keeps the other person's row and loses the caller's");
  check((await contactBalance(bob, alice)) === before.contactBob, "the other person's contact balance is identical before and after");
  check((await contactBalance(cara, alice)) === before.contactCara, "the settled pair's balance is identical before and after");
  const bobContacts = await asUser(bob.id, () => q(`select contact_user_id, full_name, balance::text as balance from public.get_contacts_with_balances()`));
  const aliceRow = bobContacts.find((r) => r.contact_user_id === alice.id);
  check(aliceRow?.full_name === "Deleted user" && aliceRow.balance === before.contactBob, "the other person still sees the deleted user's name and the open balance in their contacts");
  check((await contactRow(bob, cara)) === 1 && (await contactRow(cara, bob)) === 1, "contacts that do not involve them are untouched");
  check(
    (await count(`select 1 from public.contact_requests where requester_id = $1 or recipient_id = $1`, [alice.id])) === 0 &&
      (await count(`select 1 from public.contact_requests where requester_id = $1 and recipient_id = $2`, [bob.id, eve.id])) === 1,
    "their contact requests (both directions) are gone and others' requests stay"
  );
  const settings = (x, y) => {
    const [lo, hi] = x.id < y.id ? [x, y] : [y, x];
    return count(`select 1 from public.contact_pair_settings where user_lo = $1 and user_hi = $2`, [lo.id, hi.id]);
  };
  check((await settings(alice, dan)) === 0, "the settings of a pair with no ledger are deleted");
  check((await settings(alice, bob)) === 1, "the settings of a pair whose ledger stays are kept (the retained ledger is in that currency)");
  check(
    (await count(`select 1 from public.contact_expenses where paid_by = $1`, [alice.id])) >= 1 &&
      (await count(`select 1 from public.contact_expense_splits where user_id = $1`, [alice.id])) >= 1 &&
      (await count(`select 1 from public.contact_payments where paid_by = $1`, [alice.id])) >= 1,
    "the one-on-one expenses, splits and payments they took part in are kept"
  );

  // A second call and a new sign-up with the same email.
  const afterFirst = await snapshot();
  check((await errorOf(call(alice))) === null, "a second call as the same user returns without error");
  check((await snapshot()) === afterFirst, "and changes nothing");
  const again = await signUp(alice.email, "Alice Again");
  const fresh = await profile({ id: again });
  check(again !== alice.id && fresh.full_name === "Alice Again" && fresh.deleted_at === null && fresh.avatar_url === null, "signing up again with the same email gets a new id and a clean profile");
  check(
    (await count(`select 1 from public.group_members where user_id = $1`, [again])) === 0 &&
      (await count(`select 1 from public.contacts where owner_id = $1 or contact_user_id = $1`, [again])) === 0 &&
      (await asUser(again, () => count(`select 1 from public.get_contacts_with_balances()`))) === 0,
    "the new account has no groups, contacts or balances from the old one"
  );
  check(
    (await asUser(bob.id, () => q(`select * from public.check_emails_registered($1::text[])`, [[alice.email]]))).length === 1,
    "the email is registered again under the new account"
  );

  // ---- A failure in the middle rolls everything back ------------------------------
  {
    const [z, w, o] = [await user("Zed"), await user("Wren"), await user("Orla")];
    await befriend(z, w);
    const gz = await makeGroup(z, [w], "Rollback");
    await expense(gz, z, z, 20, equalShares([z, w], 20));
    const sz = await groupSchedule(z, gz, z, equalShares([z, w], 20), await day(0));
    await expense(gz, z, z, 8, equalShares([z, w], 8), { date: await later(7) });
    await contactExpense(z, w, z, 10, equalShares([z, w], 10));
    await contactExpense(z, w, z, 6, equalShares([z, w], 6), { date: await later(7) });
    await asUser(z.id, () => db.query(`select public.send_contact_request($1)`, [o.email]));
    const solo = await makeGroup(z, [], "Solo");
    const pending = await futureRows(sz.id);
    const snap = await snapshot();
    check(pending > 0, "setup: the schedule has pending rows");

    await db.exec(`
      create function auth.tmp_block_delete() returns trigger language plpgsql as
        $$ begin raise exception 'forced failure'; end $$;
      create trigger tmp_block before delete on auth.users for each row execute function auth.tmp_block_delete();
    `);
    let failed;
    try {
      failed = await errorOf(call(z));
    } finally {
      await db.exec(`drop trigger tmp_block on auth.users; drop function auth.tmp_block_delete()`);
    }
    check(failed === "forced failure", `a failure at the last step raises it to the caller (got: ${failed})`);
    check((await snapshot()) === snap, "and rolls everything back: every table the deletion touches is byte-identical");
    const p = await profile(z);
    check(p.deleted_at === null && p.full_name === "Zed" && (await authUsers(z)) === 1, "the profile is not a tombstone and the auth user is still there");
    check((await scheduleState(sz.id)).stopped === false && (await futureRows(sz.id)) === pending && (await groupExists(solo)), "the schedule still runs, its rows and the solo group are still there");
    check((await errorOf(call(z))) === null && (await profile(z)).deleted_at !== null && (await authUsers(z)) === 0, "with the failure gone the same call succeeds");
  }

  // ---- The AFTER DELETE trigger on auth.users ---------------------------------------
  const trig = await q(`
    select t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) as def, p.proname
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal order by 1
  `);
  const after = trig.find((t) => t.tgname === "on_auth_user_deleted");
  check(
    after?.proname === "_tombstone_deleted_auth_user" && /AFTER DELETE ON auth\.users FOR EACH ROW/.test(after.def),
    "on_auth_user_deleted is an AFTER DELETE ... FOR EACH ROW trigger on auth.users calling _tombstone_deleted_auth_user"
  );
  check(trig.some((t) => t.tgname === "on_auth_user_created"), "the sign-up trigger is still there");

  {
    const [p, r, s] = [await user("Pat"), await user("Rex"), await user("Sky")];
    await db.query(`update public.profiles set avatar_url = 'https://example.com/pat.png' where id = $1`, [p.id]);
    await befriend(p, r);
    const gp = await makeGroup(p, [r, s], "Raw");
    await setJoinOrder(gp, [p, r, s]);
    await expense(gp, p, p, 60, equalShares([p, r, s], 60));
    await contactExpense(p, r, p, 10, equalShares([p, r], 10));
    const balBefore = await groupBalances(gp, r);
    const ledger = () =>
      count(`select 1 from public.expenses where group_id = $1`, [gp]) .then(async (n) =>
        json([n, await count(`select 1 from public.expense_splits`), await count(`select 1 from public.contact_expenses where paid_by = $1`, [p.id]), await count(`select 1 from public.group_members where group_id = $1`, [gp])]));
    const ledgerBefore = await ledger();

    await db.query(`delete from auth.users where id = $1`, [p.id]);
    const t = await profile(p);
    check(t.full_name === "Deleted user" && t.avatar_url === null && t.deleted_at !== null, "a raw delete from auth.users leaves a tombstone profile: name wiped, avatar removed, deleted_at set");
    check((await ledger()) === ledgerBefore, "and the ledger and the memberships are intact (a raw delete does no group or contact clean-up)");
    const balAfter = await groupBalances(gp, r);
    check(
      json(balAfter.filter((x) => x.user_id !== p.id)) === json(balBefore.filter((x) => x.user_id !== p.id)) &&
        balAfter.find((x) => x.user_id === p.id).full_name === "Deleted user",
      "the other members' balances are identical and the ghost is named 'Deleted user'"
    );
    check((await count(`select 1 from public.contacts where owner_id = $1 or contact_user_id = $1`, [p.id])) === 2, "a raw delete leaves the contacts rows as they are");

    // Idempotent: a tombstone keeps its own deleted_at, and a missing profile does not raise.
    const [u1, u2] = [await user("Una"), await user("Uri")];
    await db.query(`update public.profiles set deleted_at = '2020-01-01T00:00:00Z', full_name = 'Deleted user' where id = $1`, [u1.id]);
    await db.query(`delete from auth.users where id = $1`, [u1.id]);
    check(
      (await one(`select deleted_at = '2020-01-01T00:00:00Z' as same from public.profiles where id = $1`, [u1.id])).same,
      "a raw delete of an account that is already a tombstone does not touch it (idempotent)"
    );
    await db.query(`delete from public.profiles where id = $1`, [u2.id]);
    check((await errorOf(db.query(`delete from auth.users where id = $1`, [u2.id]))) === null, "a raw delete with no profile row does not raise");
    check((await errorOf(db.query(`delete from auth.users where id = gen_random_uuid()`))) === null, "a raw delete that matches nothing is fine");

    // It never raises: an error inside is swallowed with a NOTICE.
    const w = await user("Wes");
    await db.exec(`
      create function auth.tmp_block_update() returns trigger language plpgsql as
        $$ begin raise exception 'boom'; end $$;
      create trigger tmp_block_update before update on public.profiles for each row execute function auth.tmp_block_update();
    `);
    const notices = [];
    let swallowed;
    try {
      swallowed = await errorOf(db.query(`delete from auth.users where id = $1`, [w.id], { onNotice: (n) => notices.push(n.message) }));
    } finally {
      await db.exec(`drop trigger tmp_block_update on public.profiles; drop function auth.tmp_block_update()`);
    }
    check(swallowed === null && (await authUsers(w)) === 0, "when the trigger's own update fails, the delete still succeeds");
    check(notices.some((m) => /boom/.test(m)), `and the error is raised as a NOTICE (got: ${notices.join(" | ")})`);
    check((await profile(w)).deleted_at === null, "the profile is then left as it was");
  }

  const leftover = await count(`select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('auth', 'public') and p.proname like 'tmp\\_%' union all select 1 from pg_class where relname = 'tmp_seen'`);
  check(leftover === 0, "the temporary test triggers and functions are gone");
}
