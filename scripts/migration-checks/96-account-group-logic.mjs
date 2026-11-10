// Account deletion, piece 2: group and membership logic (database only).
// A deleted account leaves a tombstone profile (profiles.deleted_at). This piece
// adds the private helper that takes one user out of one group the way a
// deletion needs: delete the group when nobody alive is left, hand the group to
// the longest-standing live member, and drop the membership only when that
// cannot move anyone else's balance (otherwise keep it as a ghost). It also
// makes leave_group hand over to a live member, refuses tombstones in new
// expenses and schedules, and proves settlements with a ghost still work.

const REFUSED = "Deleted users cannot be added to new expenses";

export default async function accountGroupLogic({ db, asUser, signUp, check }) {
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
    const email = `agl-${name.toLowerCase()}-${seq}@example.com`;
    return { id: await signUp(email, name), email, name };
  };
  const day = async (n) =>
    (await one(`select to_char((now() at time zone 'UTC')::date + $1::int, 'YYYY-MM-DD') as d`, [n])).d;
  const later = async (days) => (await one(`select (now() + make_interval(days => $1))::text as d`, [days])).d;

  const makeGroup = (creator, others, currency = "USD") =>
    asUser(creator.id, async () =>
      (await one(`select * from public.create_group_with_members($1, $2::text[], $3)`, [
        "Agl group",
        others.map((u) => u.email),
        currency,
      ])).id
    );
  // First in the list joined first.
  const setJoinOrder = async (groupId, users) => {
    for (const [i, u] of users.entries()) {
      await db.query(
        `update public.group_members set joined_at = now() - make_interval(mins => $3)
          where group_id = $1 and user_id = $2`,
        [groupId, u.id, 1000 - i]
      );
    }
  };
  const tombstone = (u) =>
    db.query(`update public.profiles set deleted_at = now(), full_name = 'Deleted user' where id = $1`, [u.id]);
  const half = (a, b, amount) => [
    { userId: a.id, amount },
    { userId: b.id, amount },
  ];
  const expense = (groupId, actor, paidBy, amount, splits, o = {}) =>
    asUser(actor.id, async () =>
      one(
        `select * from public.create_expense_with_splits($1, $2, $3, $4, null, $5::public.split_type, $6::jsonb, $7, $8, $9)`,
        [
          groupId, paidBy.id, amount, o.description ?? "Dinner", o.type ?? "exact",
          json(splits.map((s) => ({ userId: s.userId, amount: s.amount, ...(s.baseAmount != null ? { baseAmount: s.baseAmount } : {}) }))),
          o.date ?? null, o.currency ?? "USD", o.rate ?? 1,
        ]
      )
    );
  const equalShares = (users, total) => users.map((u) => ({ userId: u.id, amount: total / users.length }));
  const pay = (groupId, actor, from, to, amount, date = null) =>
    asUser(actor.id, async () =>
      one(`select * from public.create_payment($1, $2, $3, $4, null, null, $5)`, [groupId, from.id, to.id, amount, date])
    );

  const balances = (groupId, viewer) =>
    asUser(viewer.id, () =>
      q(`select user_id, full_name, balance::text as balance from public.get_group_balances($1) order by user_id`, [
        groupId,
      ])
    );
  const balanceOf = async (groupId, viewer, target) =>
    Number((await balances(groupId, viewer)).find((r) => r.user_id === target.id)?.balance);
  const without = (rows, ...users) => rows.filter((r) => !users.some((u) => u.id === r.user_id));
  const isMember = async (groupId, u) =>
    Number((await one(`select count(*) n from public.group_members where group_id = $1 and user_id = $2`, [groupId, u.id])).n) === 1;
  const groupExists = async (groupId) =>
    Number((await one(`select count(*) n from public.groups where id = $1`, [groupId])).n) === 1;
  const ownerOf = async (groupId) => (await one(`select created_by from public.groups where id = $1`, [groupId]))?.created_by;
  const leaveHelper = (u, groupId) => db.query(`select public._account_leave_group($1, $2)`, [u.id, groupId]);

  // ---- The helpers exist once, private, and cannot be called by a client -------
  const procs = await q(`
    select p.proname, p.oid::regprocedure::text as sig, p.prosecdef, p.prorettype::regtype::text as ret,
      coalesce(p.proconfig::text, '') as config,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authed,
      exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('_account_leave_group', '_group_member_balance')
    order by 1
  `);
  const leaveFn = procs.find((r) => r.proname === "_account_leave_group");
  const balFn = procs.find((r) => r.proname === "_group_member_balance");
  check(procs.length === 2, "exactly one _account_leave_group and one _group_member_balance exist");
  check(
    leaveFn?.sig === "_account_leave_group(uuid,uuid)" && leaveFn.ret === "void" && leaveFn.prosecdef &&
      leaveFn.config.includes("search_path=public, pg_temp"),
    "_account_leave_group(uuid, uuid) returns void, SECURITY DEFINER, search_path pinned to public, pg_temp"
  );
  check(
    balFn?.sig === "_group_member_balance(uuid,uuid)" && balFn.ret === "numeric" && balFn.prosecdef &&
      balFn.config.includes("search_path=public, pg_temp"),
    "_group_member_balance(uuid, uuid) returns numeric, SECURITY DEFINER, search_path pinned to public, pg_temp"
  );
  check(
    procs.every((r) => !r.anon && !r.authed && !r.public_exec),
    "neither helper is executable by anon, authenticated or PUBLIC"
  );

  const amy = await user("Amy");
  const ben = await user("Ben");
  const cat = await user("Cat");
  const dee = await user("Dee");

  const aclGroup = await makeGroup(amy, [ben]);
  check(
    (await codeOf(asUser(amy.id, () => db.query(`select public._account_leave_group($1, $2)`, [amy.id, aclGroup])))) === "42501",
    "authenticated calling _account_leave_group is permission denied (42501)"
  );
  check(
    (await codeOf(asAnon(() => db.query(`select public._account_leave_group($1, $2)`, [amy.id, aclGroup])))) === "42501",
    "anon calling _account_leave_group is permission denied (42501)"
  );
  check(
    (await codeOf(asUser(amy.id, () => db.query(`select public._group_member_balance($1, $2)`, [aclGroup, amy.id])))) === "42501",
    "authenticated calling _group_member_balance is permission denied (42501)"
  );
  check(await isMember(aclGroup, amy), "the refused calls changed nothing");

  // ---- The balance helper equals get_group_balances, in every group shape ------
  const shapes = [];
  {
    const [a, b, c] = [await user("Ann"), await user("Bo"), await user("Cy")];
    const eq = await makeGroup(a, [b, c]);
    await expense(eq, a, a, 30, equalShares([a, b, c], 30), { type: "equal" });
    await expense(eq, b, c, 10, [{ userId: b.id, amount: 3.33 }, { userId: c.id, amount: 3.33 }, { userId: a.id, amount: 3.34 }], { type: "equal" });
    shapes.push(["equal splits", eq, a, [a, b, c]]);

    const ex = await makeGroup(a, [b, c]);
    await expense(ex, a, b, 45, [{ userId: a.id, amount: 5 }, { userId: b.id, amount: 15 }, { userId: c.id, amount: 25 }]);
    shapes.push(["exact splits", ex, a, [a, b, c]]);

    const pct = await makeGroup(b, [a, c]);
    await expense(pct, b, b, 80, [{ userId: a.id, amount: 20 }, { userId: b.id, amount: 40 }, { userId: c.id, amount: 20 }], { type: "percentage" });
    shapes.push(["percentage splits", pct, b, [a, b, c]]);

    const withPayment = await makeGroup(a, [b, c]);
    await expense(withPayment, a, a, 60, equalShares([a, b, c], 60), { type: "equal" });
    await pay(withPayment, b, b, a, 12.5);
    shapes.push(["a payment", withPayment, a, [a, b, c]]);

    const foreign = await makeGroup(a, [b]);
    await expense(foreign, a, a, 50, [{ userId: a.id, amount: 20 }, { userId: b.id, amount: 30 }], { currency: "EUR", rate: 1.1 });
    shapes.push(["a foreign-currency expense", foreign, a, [a, b]]);

    const simplified = await makeGroup(a, [b, c]);
    await asUser(a.id, () => db.query(`select public.set_group_simplify_debts($1, true)`, [simplified]));
    await expense(simplified, a, a, 30, equalShares([a, b, c], 30), { type: "equal" });
    await expense(simplified, b, b, 12, [{ userId: a.id, amount: 6 }, { userId: c.id, amount: 6 }]);
    await pay(simplified, c, c, a, 4);
    shapes.push(["a simplify_debts group", simplified, a, [a, b, c]]);

    const raw = await makeGroup(a, [b, c]);
    await asUser(a.id, () => db.query(`select public.set_group_simplify_debts($1, false)`, [raw]));
    await expense(raw, c, c, 9, equalShares([a, b, c], 9), { type: "equal" });
    shapes.push(["a raw-ledger group (simplify off)", raw, a, [a, b, c]]);

    const future = await makeGroup(a, [b]);
    await expense(future, a, a, 10, half(a, b, 5), { date: await later(10) });
    await expense(future, a, a, 8, half(a, b, 4));
    shapes.push(["a group with a future-dated expense", future, a, [a, b]]);
  }
  for (const [label, gid, viewer, members] of shapes) {
    const shown = await balances(gid, viewer);
    const computed = [];
    for (const m of members) {
      computed.push({ user_id: m.id, balance: (await one(`select public._group_member_balance($1, $2)::text as b`, [gid, m.id])).b });
    }
    computed.sort((x, y) => (x.user_id < y.user_id ? -1 : 1));
    check(
      json(shown.map((r) => ({ user_id: r.user_id, balance: r.balance }))) === json(computed),
      `_group_member_balance equals get_group_balances for every member of ${label}`
    );
  }
  check(
    Number((await one(`select count(*) n from public.group_members where group_id = $1`, [shapes[0][1]])).n) === 3,
    "the balance helper reads and changes nothing"
  );

  // ---- _account_leave_group: not a member --------------------------------------
  {
    const [a, b, outsider] = [await user("Mo"), await user("Ned"), await user("Out")];
    const g = await makeGroup(a, [b]);
    await expense(g, a, a, 20, half(a, b, 10));
    const snapshot = async () =>
      json([
        await q(`select id, created_by from public.groups order by id`),
        await q(`select group_id, user_id from public.group_members order by group_id, user_id`),
        await q(`select id from public.expenses order by id`),
      ]);
    const before = await snapshot();
    await leaveHelper(outsider, g);
    await leaveHelper(a, "00000000-0000-0000-0000-000000000000");
    check((await snapshot()) === before, "a user who is not a member (or an unknown group): nothing changes");
  }

  // ---- No live member left: the group goes -------------------------------------
  {
    const solo = await user("Sol");
    const g = await makeGroup(solo, []);
    await expense(g, solo, solo, 10, [{ userId: solo.id, amount: 10 }]);
    await leaveHelper(solo, g);
    check(!(await groupExists(g)), "the sole member leaving deletes the group");
    check(
      Number((await one(`select count(*) n from public.group_members where group_id = $1`, [g])).n) === 0 &&
        Number((await one(`select count(*) n from public.expenses where group_id = $1`, [g])).n) === 0,
      "deleting the group cascades its members and expenses"
    );
  }
  {
    const [a, b, c] = [await user("Ola"), await user("Pip"), await user("Quin")];
    const g = await makeGroup(a, [b, c]);
    await expense(g, a, a, 30, equalShares([a, b, c], 30), { type: "equal" });
    await tombstone(b);
    await tombstone(c);
    await leaveHelper(a, g);
    check(!(await groupExists(g)), "every other member a tombstone: the group is deleted even with money outstanding");
  }
  {
    const [a, b, c] = [await user("Rex"), await user("Sam"), await user("Tia")];
    const g = await makeGroup(a, [b, c]);
    await tombstone(b);
    await leaveHelper(a, g);
    check(
      (await groupExists(g)) && !(await isMember(g, a)) && (await ownerOf(g)) === c.id,
      "one live member remains: the group stays and the live member gets it"
    );
  }

  // ---- Creator hand-over --------------------------------------------------------
  {
    const [a, b, c, d] = [await user("Uma"), await user("Vic"), await user("Wes"), await user("Xia")];
    const g = await makeGroup(a, [b, c, d]);
    await setJoinOrder(g, [a, b, c, d]);
    await tombstone(b);
    await leaveHelper(a, g);
    check((await ownerOf(g)) === c.id, "the group goes to the longest-standing live member, skipping a tombstone who joined first");
    check(!(await isMember(g, a)), "a creator with a zero balance leaves after the hand-over");
  }
  {
    const [a, b] = [await user("Yan"), await user("Zed")];
    // Added in descending id order, so insertion order cannot pass for the tie-break.
    const tied = [await user("Abe"), await user("Bea"), await user("Cid"), await user("Dov")].sort((x, y) =>
      x.id < y.id ? 1 : -1
    );
    const g = await makeGroup(a, [b, ...tied]);
    await setJoinOrder(g, [a, b]);
    await db.query(
      `update public.group_members set joined_at = (select joined_at from public.group_members where group_id = $1 and user_id = $2)
         + interval '5 minutes' where group_id = $1 and user_id = any ($3::uuid[])`,
      [g, a.id, tied.map((u) => u.id)]
    );
    await tombstone(b);
    await leaveHelper(a, g);
    const expected = tied[tied.length - 1].id;
    check((await ownerOf(g)) === expected, "members who joined at the same instant: the lowest user id gets the group");
  }
  {
    const [a, b, c] = [await user("Cal"), await user("Dot"), await user("Eve")];
    const g = await makeGroup(a, [b, c]);
    await setJoinOrder(g, [a, b, c]);
    await expense(g, a, a, 30, equalShares([a, b, c], 30), { type: "equal" });
    await leaveHelper(a, g);
    check(
      (await ownerOf(g)) === b.id && (await isMember(g, a)),
      "a creator who must stay as a ghost still hands the group over"
    );
  }
  {
    const [a, b, c] = [await user("Fox"), await user("Gus"), await user("Hal")];
    const g = await makeGroup(a, [b, c]);
    await setJoinOrder(g, [a, b, c]);
    await leaveHelper(b, g);
    check((await ownerOf(g)) === a.id && !(await isMember(g, b)), "a member who is not the creator leaves without touching ownership");
  }

  // ---- Zero balance: the membership goes and nobody's numbers move ---------------
  const threeWay = async () => {
    const [a, b, c] = [await user("Ida"), await user("Jon"), await user("Kay")];
    const g = await makeGroup(a, [b, c]);
    await setJoinOrder(g, [a, b, c]);
    await expense(g, a, a, 30, equalShares([a, b, c], 30), { type: "equal" });
    await expense(g, c, c, 30, equalShares([a, b, c], 30), { type: "equal" });
    return { a, b, c, g };
  };
  {
    const { a, b, c, g } = await threeWay();
    await pay(g, b, b, a, 10);
    check((await balanceOf(g, b, a)) === 0, "fixture: the leaver's net balance is zero while the others' are not");
    const before = await balances(g, b);
    check(Number(before.find((r) => r.user_id === b.id).balance) === -10, "fixture: another member is owed or owes something");
    await leaveHelper(a, g);
    check(!(await isMember(g, a)), "zero balance and nothing upcoming: the membership is removed");
    check(
      json(await balances(g, b)) === json(without(before, a)),
      "everyone else's balances are identical before and after the removal"
    );
    check((await ownerOf(g)) === b.id, "the leaving creator handed the group over");
  }

  // ---- Non-zero balance: the ghost stays ------------------------------------------
  {
    const { a, b, c, g } = await threeWay();
    const before = await balances(g, b);
    check(Number(before.find((r) => r.user_id === a.id).balance) === 10, "fixture: the leaver is owed money");
    const owing = await makeGroup(a, [b]);
    await expense(owing, b, b, 20, half(a, b, 10));
    await tombstone(a);
    await leaveHelper(a, g);
    check(await isMember(g, a), "a non-zero balance keeps the membership as a ghost");
    const after = await balances(g, b);
    check(json(after.map(({ user_id, balance }) => ({ user_id, balance }))) === json(before.map(({ user_id, balance }) => ({ user_id, balance }))),
      "everyone's balances, the ghost's included, are identical before and after");
    check(
      after.find((r) => r.user_id === a.id)?.full_name === "Deleted user",
      "the ghost is still listed by get_group_balances, as Deleted user"
    );
    await leaveHelper(a, owing);
    check(await isMember(owing, a), "a negative balance also keeps the membership");
  }
  {
    const [a, b] = [await user("Lia"), await user("Max")];
    const g = await makeGroup(a, [b]);
    await expense(g, a, a, 10, half(a, b, 5));
    await pay(g, b, b, a, 5);
    await leaveHelper(a, g);
    check(
      (await groupExists(g)) && !(await isMember(g, a)) && (await ownerOf(g)) === b.id,
      "a balance that nets to exactly zero after a payment counts as settled"
    );
  }
  {
    const [a, b] = [await user("Nat"), await user("Oz")];
    const g = await makeGroup(a, [b]);
    await db.query(`insert into public.expenses (group_id, paid_by, amount, description, split_type, base_amount)
                    values ($1, $2, 0.01, 'tiny', 'exact', 0.01)`, [g, a.id]);
    const e = await one(`select id from public.expenses where group_id = $1`, [g]);
    await db.query(`insert into public.expense_splits (expense_id, user_id, amount, base_amount) values ($1, $2, 0.01, 0.01)`, [e.id, b.id]);
    await leaveHelper(a, g);
    check(await isMember(g, a), "a balance of 0.01 is not zero: the membership stays");
  }

  // ---- Future-dated rows and running schedules keep the membership ------------------
  {
    const [a, b] = [await user("Pam"), await user("Quo")];
    const when = await later(10);

    const g1 = await makeGroup(a, [b]);
    await expense(g1, b, b, 20, half(a, b, 10), { date: when });
    check((await balanceOf(g1, b, a)) === 0, "fixture: a future-dated expense is not in the balance yet");
    await leaveHelper(a, g1);
    check(await isMember(g1, a), "a future-dated expense where they are in the splits keeps the membership");

    const g2 = await makeGroup(a, [b]);
    await expense(g2, a, a, 20, [{ userId: b.id, amount: 20 }, { userId: a.id, amount: 0 }], { date: when });
    await leaveHelper(a, g2);
    check(await isMember(g2, a), "a future-dated expense they paid keeps the membership");

    const g3 = await makeGroup(a, [b]);
    await pay(g3, b, b, a, 5, when);
    await leaveHelper(a, g3);
    check(await isMember(g3, a), "a future-dated payment involving them keeps the membership");

    const g4 = await makeGroup(a, [b]);
    await expense(g4, b, b, 20, [{ userId: b.id, amount: 20 }, { userId: a.id, amount: 0 }], { date: when });
    await leaveHelper(a, g4);
    check(!(await isMember(g4, a)), "a future-dated expense that gives them a zero share does not keep the membership");

    const schedule = (uid, groupId, paidBy, splits, start) =>
      asUser(uid.id, async () =>
        one(
          `select * from public.create_recurring_schedule($1, null, $2, 20, 'Rent', null, 'exact'::public.split_type, $3::jsonb,
             'USD', 1, $4::date, 'UTC', 'monthly', null, null)`,
          [groupId, paidBy.id, json(splits), start]
        )
      );
    const g5 = await makeGroup(a, [b]);
    const s5 = await schedule(b, g5, b, half(a, b, 10), await day(15));
    await leaveHelper(a, g5);
    check(await isMember(g5, a), "a running schedule where they are in the splits keeps the membership");

    const g6 = await makeGroup(a, [b]);
    await schedule(a, g6, a, [{ userId: b.id, amount: 20 }, { userId: a.id, amount: 0 }], await day(15));
    await leaveHelper(a, g6);
    check(await isMember(g6, a), "a running schedule where they are the payer keeps the membership");

    await asUser(b.id, () => db.query(`select * from public.stop_recurring_schedule($1)`, [s5.id]));
    await leaveHelper(a, g5);
    check(!(await isMember(g5, a)), "once the schedule is stopped it no longer keeps the membership");
  }

  // ---- leave_group hands over to a live member ------------------------------------------
  {
    const [a, b, c] = [await user("Rae"), await user("Sid"), await user("Tom")];
    const g = await makeGroup(a, [b, c]);
    await setJoinOrder(g, [a, b, c]);
    await tombstone(b);
    await asUser(a.id, () => db.query(`select public.leave_group($1)`, [g]));
    check((await ownerOf(g)) === c.id, "leave_group hands the group to a live member, skipping a tombstone who joined first");
    check(!(await isMember(g, a)), "leave_group still removes the leaver");
  }
  {
    const [a, b, c] = [await user("Uli"), await user("Val"), await user("Wil")];
    const g = await makeGroup(a, [b, c]);
    await setJoinOrder(g, [a, b, c]);
    await asUser(a.id, () => db.query(`select public.leave_group($1)`, [g]));
    check((await ownerOf(g)) === b.id, "leave_group still picks the longest-standing member when all are live");
  }
  {
    const [a, b] = [await user("Xen"), await user("Yul")];
    const g = await makeGroup(a, [b]);
    await expense(g, b, b, 10, [{ userId: b.id, amount: 10 }], { date: await later(5) });
    await tombstone(b);
    check(await isMember(g, b), "fixture: the only other member is a ghost");
    const message = await errorOf(asUser(a.id, () => db.query(`select public.leave_group($1)`, [g])));
    check(message === null, `a creator leaving a group whose only other member is a ghost does not fail (${message ?? "ok"})`);
    check(!(await groupExists(g)), "and the group, which no live member can see, is deleted");
  }
  {
    const fns = await q(`select count(*)::int n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
                          where s.nspname = 'public' and p.proname = 'leave_group'`);
    const acl = await one(`select has_function_privilege('authenticated', 'public.leave_group(uuid)', 'execute') as authed`);
    check(fns[0].n === 1 && acl.authed, "there is exactly one leave_group and authenticated can still run it");
  }

  // ---- Settling with a ghost still works --------------------------------------------------
  {
    const [a, b] = [await user("Zoe"), await user("Ari")];
    const g = await makeGroup(a, [b]);
    await expense(g, a, a, 20, half(a, b, 10));
    await tombstone(b);
    check((await balanceOf(g, a, b)) === -10, "fixture: the ghost owes 10");
    const p = await pay(g, a, b, a, 4);
    check((await balanceOf(g, a, b)) === -6 && (await balanceOf(g, a, a)) === 6, "create_payment with the ghost as payer moves both balances");
    const edited = await asUser(a.id, () =>
      one(`select * from public.update_payment($1, $2, $3, 10, 'settled')`, [p.id, b.id, a.id])
    );
    check(
      Number(edited.amount) === 10 && (await balanceOf(g, a, b)) === 0 && (await balanceOf(g, a, a)) === 0,
      "update_payment with the ghost as payer settles the balance"
    );
    const overpay = await pay(g, a, a, b, 3);
    check((await balanceOf(g, a, b)) === -3 && (await balanceOf(g, a, a)) === 3, "create_payment with the ghost as recipient works and moves both balances");
    const moved = await asUser(a.id, () =>
      one(`select * from public.update_payment($1, $2, $3, 3, null)`, [overpay.id, b.id, a.id])
    );
    check(
      moved.paid_to === a.id && moved.paid_by === b.id &&
        (await balanceOf(g, a, b)) === 3 && (await balanceOf(g, a, a)) === -3,
      "update_payment can move a payment between the ghost and the live member in either direction"
    );
    check(await isMember(g, b), "the ghost is still a member throughout");
  }

  // ---- No new expense may involve a tombstone ------------------------------------------------
  {
    const [a, b, c] = [await user("Bay"), await user("Cos"), await user("Dax")];
    const g = await makeGroup(a, [b, c]);
    const old = await expense(g, a, a, 30, equalShares([a, b, c], 30), { type: "equal", description: "Before" });
    const onlyLive = await expense(g, a, a, 20, half(a, c, 10), { description: "Live pair" });
    const ghostPaid = await expense(g, b, b, 20, half(a, c, 10), { description: "Ghost paid" });
    await tombstone(b);

    const createMsg = (payer, splits) => errorOf(expense(g, a, payer, 12, splits));
    check(
      (await createMsg(b, [{ userId: a.id, amount: 6 }, { userId: c.id, amount: 6 }])) === REFUSED,
      "create_expense_with_splits refuses a tombstone as payer"
    );
    check(
      (await createMsg(a, [{ userId: a.id, amount: 6 }, { userId: b.id, amount: 6 }])) === REFUSED,
      "create_expense_with_splits refuses a tombstone in the splits"
    );
    check(
      (await createMsg(a, [{ userId: a.id, amount: 6 }, { userId: c.id, amount: 6 }])) === null,
      "create_expense_with_splits still accepts live members in the same group"
    );
    check(
      Number((await one(`select count(*) n from public.expenses where group_id = $1 and description = 'Dinner'`, [g])).n) === 1,
      "the refused creates wrote nothing"
    );

    const update = (id, payer, splits, o = {}) =>
      asUser(a.id, () =>
        one(`select * from public.update_expense_with_splits($1, $2, $3, $4, null, 'exact', $5::jsonb)`, [
          id, payer.id, o.amount ?? 20, o.description ?? "Live pair", json(splits),
        ])
      );
    check(
      (await errorOf(update(onlyLive.id, a, [{ userId: a.id, amount: 10 }, { userId: b.id, amount: 10 }]))) === REFUSED,
      "update_expense_with_splits refuses adding a tombstone to the splits"
    );
    check(
      (await errorOf(update(onlyLive.id, b, half(a, c, 10)))) === REFUSED,
      "update_expense_with_splits refuses a tombstone as the new payer"
    );
    check(
      (await errorOf(update(onlyLive.id, a, half(a, c, 10), { description: "Renamed" }))) === null,
      "update_expense_with_splits still edits an expense among live members"
    );
    check(
      (await errorOf(update(old.id, a, equalShares([a, b, c], 30).map((s) => ({ ...s, amount: 10 })), { amount: 30, description: "Renamed before" }))) === null,
      "an old expense that already involves the ghost can still be edited with the ghost kept"
    );
    check(
      (await errorOf(update(ghostPaid.id, b, half(a, c, 10), { description: "Renamed, ghost still paid" }))) === null,
      "an old expense the ghost paid can still be edited with the ghost kept as payer"
    );
    check(
      (await errorOf(update(onlyLive.id, a, half(a, c, 10), { description: "Back" }))) === null &&
        (await errorOf(update(ghostPaid.id, a, half(a, c, 10), { description: "Moved off the ghost" }))) === null,
      "moving the payer off a ghost is allowed"
    );
    check(
      (await errorOf(update(onlyLive.id, b, half(a, c, 10), { description: "Back to ghost" }))) === REFUSED,
      "and a ghost who was not the payer still cannot become one"
    );
    check(
      (await balanceOf(g, a, b)) === -10,
      "the ghost's balance is what the remaining expense gives it"
    );
  }

  // ---- Contacts ---------------------------------------------------------------------------------
  {
    const [a, b] = [await user("Eko"), await user("Fey")];
    await asUser(a.id, () => db.query(`select public.send_contact_request($1)`, [b.email]));
    await asUser(b.id, async () => {
      const r = await one(`select id from public.get_contact_requests() where direction = 'incoming' and user_id = $1`, [a.id]);
      await db.query(`select public.respond_contact_request($1, true)`, [r.id]);
    });
    const before = await asUser(a.id, () =>
      one(`select * from public.create_contact_expense_with_splits($1, $2, 8, 'Lunch', null, 'exact', $3::jsonb)`, [
        b.id, a.id, json(half(a, b, 4)),
      ])
    );
    await tombstone(b);
    const create = (paidBy, splits) =>
      errorOf(
        asUser(a.id, () =>
          db.query(`select * from public.create_contact_expense_with_splits($1, $2, 6, 'Coffee', null, 'exact', $3::jsonb)`, [
            b.id, paidBy.id, json(splits),
          ])
        )
      );
    check(
      (await create(a, half(a, b, 3))) === REFUSED,
      "create_contact_expense_with_splits refuses a tombstone in the splits"
    );
    check((await create(b, half(a, b, 3))) === REFUSED, "create_contact_expense_with_splits refuses a tombstone as payer");
    check(
      (await create(a, [{ userId: a.id, amount: 6 }])) === REFUSED,
      "create_contact_expense_with_splits refuses a new expense with a tombstone contact even when only the live user is in it"
    );
    const edit = (payer, splits) =>
      errorOf(
        asUser(a.id, () =>
          db.query(`select * from public.update_contact_expense_with_splits($1, $2, 8, 'Lunch edited', null, 'exact', $3::jsonb)`, [
            before.id, payer.id, json(splits),
          ])
        )
      );
    check((await edit(a, half(a, b, 4))) === null, "an old 1:1 expense that already involves the tombstone can still be edited with them kept");
    const aOnly = await db.query(
      `insert into public.contact_expenses (paid_by, user_lo, user_hi, amount, description, split_type, base_amount)
       values ($1, $2, $3, 5, 'Mine', 'exact', 5) returning id`,
      [a.id, a.id < b.id ? a.id : b.id, a.id < b.id ? b.id : a.id]
    );
    await db.query(`insert into public.contact_expense_splits (expense_id, user_id, amount, base_amount) values ($1, $2, 5, 5)`, [
      aOnly.rows[0].id, a.id,
    ]);
    check(
      (await errorOf(
        asUser(a.id, () =>
          db.query(`select * from public.update_contact_expense_with_splits($1, $2, 5, 'Mine', null, 'exact', $3::jsonb)`, [
            aOnly.rows[0].id, a.id, json([{ userId: a.id, amount: 2.5 }, { userId: b.id, amount: 2.5 }]),
          ])
        )
      )) === REFUSED,
      "update_contact_expense_with_splits refuses adding the tombstone to a 1:1 expense they were not in"
    );
    check(
      (await errorOf(
        asUser(a.id, () =>
          db.query(`select * from public.update_contact_expense_with_splits($1, $2, 5, 'Mine', null, 'exact', $3::jsonb)`, [
            aOnly.rows[0].id, b.id, json([{ userId: a.id, amount: 5 }]),
          ])
        )
      )) === REFUSED,
      "update_contact_expense_with_splits refuses the tombstone as the new payer"
    );
  }

  // ---- Schedules ------------------------------------------------------------------------------------
  {
    const [a, b, c] = [await user("Gil"), await user("Hope"), await user("Ian")];
    const g = await makeGroup(a, [b, c]);
    const create = (uid, paidBy, splits, over = {}) =>
      asUser(uid.id, async () =>
        one(
          `select * from public.create_recurring_schedule($1, $2, $3, 30, 'Rent', null, 'exact'::public.split_type, $4::jsonb,
             'USD', 1, $5::date, 'UTC', 'daily', null, null)`,
          [over.group === undefined ? g : over.group, over.contact ?? null, paidBy.id, json(splits), over.start ?? null]
        )
      );
    const start = await day(0);
    const live = await create(a, a, equalShares([a, b, c], 30), { start });
    const live2 = await create(a, b, equalShares([a, b, c], 30), { start });
    await tombstone(c);

    check(
      (await errorOf(create(a, a, equalShares([a, b, c], 30), { start }))) === REFUSED,
      "create_recurring_schedule refuses a group schedule with a tombstone in the splits"
    );
    check(
      (await errorOf(create(a, c, equalShares([a, b, c], 30), { start: await day(20) }))) === REFUSED,
      "create_recurring_schedule refuses a tombstone as payer, even when the schedule starts weeks from now"
    );
    check(
      (await errorOf(create(a, a, [{ userId: a.id, amount: 15 }, { userId: b.id, amount: 15 }], { start: await day(20) }))) === null,
      "create_recurring_schedule still accepts live members"
    );

    check(
      (await errorOf(
        asUser(a.id, () =>
          db.query(`select * from public.update_recurring_schedule($1, 30, null, null, 'exact', $2::jsonb)`, [
            live.id, json(equalShares([a, b, c], 30)),
          ])
        )
      )) === REFUSED,
      "update_recurring_schedule refuses adding a tombstone to the splits"
    );
    check(
      (await errorOf(
        asUser(a.id, () =>
          db.query(`select * from public.update_recurring_schedule($1, null, null, null, null, null, $2)`, [live.id, c.id])
        )
      )) === REFUSED,
      "update_recurring_schedule refuses a tombstone as the new payer"
    );
    check(
      (await errorOf(
        asUser(a.id, () => db.query(`select * from public.update_recurring_schedule($1, null, 'Renamed')`, [live.id]))
      )) === REFUSED,
      "update_recurring_schedule refuses an edit while the stored splits still hold a tombstone"
    );

    const made = Number((await one(`select count(*) n from public.expenses where schedule_id = $1`, [live.id])).n);
    const horizon = await later(3);
    await db.query(`select public._materialise_recurring($1::timestamptz)`, [horizon]);
    const after = await one(
      `select stopped_at is not null as stopped, stop_reason, failed_runs, last_error from public.recurring_schedules where id = $1`,
      [live.id]
    );
    check(
      after.stopped && after.stop_reason === "member left" && after.failed_runs === 0,
      `a schedule whose split user became a tombstone is stopped as 'member left' by the engine (got ${after.stop_reason})`
    );
    check(
      Number((await one(`select count(*) n from public.expenses where schedule_id = $1`, [live.id])).n) === made,
      "and creates no further occurrence"
    );
    const afterPayer = await one(`select stop_reason from public.recurring_schedules where id = $1`, [live2.id]);
    check(
      afterPayer.stop_reason === "member left",
      `a schedule that also has the tombstone in its splits is stopped as 'member left' (got ${afterPayer.stop_reason})`
    );

    const payerGroup = await makeGroup(a, [b, c]);
    const byPayer = await asUser(a.id, async () =>
      one(
        `select * from public.create_recurring_schedule($1, null, $2, 30, 'Gym', null, 'exact'::public.split_type, $3::jsonb,
           'USD', 1, $4::date, 'UTC', 'daily', null, null)`,
        [payerGroup, b.id, json([{ userId: a.id, amount: 30 }]), start]
      )
    );
    await db.query(`update public.profiles set deleted_at = now() where id = $1`, [b.id]);
    await db.query(`select public._materialise_recurring($1::timestamptz)`, [horizon]);
    const payerResult = await one(`select stop_reason, failed_runs from public.recurring_schedules where id = $1`, [byPayer.id]);
    check(
      payerResult.stop_reason === "member left" && payerResult.failed_runs === 0,
      `a schedule whose payer became a tombstone is stopped as 'member left' (got ${payerResult.stop_reason})`
    );
  }
  {
    const [a, b] = [await user("Jay"), await user("Kit")];
    await asUser(a.id, () => db.query(`select public.send_contact_request($1)`, [b.email]));
    await asUser(b.id, async () => {
      const r = await one(`select id from public.get_contact_requests() where direction = 'incoming' and user_id = $1`, [a.id]);
      await db.query(`select public.respond_contact_request($1, true)`, [r.id]);
    });
    const start = await day(0);
    const contactSchedule = await asUser(a.id, async () =>
      one(
        `select * from public.create_recurring_schedule(null, $1, $2, 20, 'Sub', null, 'exact'::public.split_type, $3::jsonb,
           'USD', 1, $4::date, 'UTC', 'daily', null, null)`,
        [b.id, a.id, json(half(a, b, 10)), start]
      )
    );
    await tombstone(b);
    const refused = await errorOf(
      asUser(a.id, () =>
        db.query(
          `select * from public.create_recurring_schedule(null, $1, $2, 20, 'Sub2', null, 'exact'::public.split_type, $3::jsonb,
             'USD', 1, $4::date, 'UTC', 'daily', null, null)`,
          [b.id, a.id, json(half(a, b, 10)), start]
        )
      )
    );
    check(refused === REFUSED, "create_recurring_schedule refuses a contact schedule with a tombstone contact");
    await db.query(`select public._materialise_recurring($1::timestamptz)`, [await later(3)]);
    const stopped = await one(`select stop_reason, failed_runs from public.recurring_schedules where id = $1`, [contactSchedule.id]);
    check(
      stopped.stop_reason === "member left" && stopped.failed_runs === 0,
      `a contact schedule whose other person became a tombstone is stopped as 'member left' (got ${stopped.stop_reason})`
    );
  }
}
