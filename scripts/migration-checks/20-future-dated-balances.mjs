// Future-dated rows: an expense or payment dated after now() counts toward no
// balance until its date passes, the activity feed leaves it to
// get_upcoming_expenses, leave_group refuses while one involves the member, and
// the currency guards still count it as activity.
//
// Dates are SQL expressions relative to now(), so "future" and "arrived" never
// depend on the wall clock or on sleeping.
const IN_1D = "now() + interval '1 day'";
const IN_2D = "now() + interval '2 days'";
const IN_5D = "now() + interval '5 days'";
const AGO_1D = "now() - interval '1 day'";
const AGO_1H = "now() - interval '1 hour'";
const NOW = "null";

const LEAVE_MSG =
  "You have upcoming or repeating transactions in this group. Cancel or stop them before leaving.";

const errorOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.message;
  }
};

const splitsJson = (splits) =>
  JSON.stringify(
    splits.map(([userId, amount]) => ({ userId, amount, baseAmount: amount }))
  );

const canon = (map) =>
  JSON.stringify(
    Object.entries(map)
      .map(([k, v]) => [k, Number(v)])
      .sort(([a], [b]) => (a < b ? -1 : 1))
  );

const sortedNumbers = (rows, key = "balance") =>
  JSON.stringify(rows.map((r) => Number(r[key])).sort((a, b) => a - b));

export default async ({ db, asUser, signUp, check }) => {
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];

  const createGroup = (uid, name, emails) =>
    asUser(uid, async () =>
      (
        await one(`select * from public.create_group_with_members($1, $2::text[], 'USD')`, [
          name,
          emails,
        ])
      ).id
    );

  const addExpense = (uid, groupId, paidBy, amount, splits, dateSql) =>
    asUser(uid, async () =>
      (
        await one(
          `select id from public.create_expense_with_splits($1, $2, $3, 'e', null, 'exact', $4::jsonb, ${dateSql}, 'USD', 1)`,
          [groupId, paidBy, amount, splitsJson(splits)]
        )
      ).id
    );

  const moveExpense = (uid, id, paidBy, amount, splits, dateSql) =>
    asUser(uid, () =>
      db.query(
        `select public.update_expense_with_splits($1, $2, $3, 'e', null, 'exact', $4::jsonb, ${dateSql}, 'USD', 1)`,
        [id, paidBy, amount, splitsJson(splits)]
      )
    );

  const addPayment = (uid, groupId, paidBy, paidTo, amount, dateSql) =>
    asUser(uid, async () =>
      (
        await one(
          `select id from public.create_payment($1, $2, $3, $4, null, null, ${dateSql})`,
          [groupId, paidBy, paidTo, amount]
        )
      ).id
    );

  const movePayment = (uid, id, paidBy, paidTo, amount, dateSql) =>
    asUser(uid, () =>
      db.query(`select public.update_payment($1, $2, $3, $4, null, ${dateSql})`, [
        id,
        paidBy,
        paidTo,
        amount,
      ])
    );

  const addContactExpense = (uid, contactId, paidBy, amount, splits, dateSql) =>
    asUser(uid, async () =>
      (
        await one(
          `select id from public.create_contact_expense_with_splits($1, $2, $3, 'ce', null, 'exact', $4::jsonb, ${dateSql}, 'USD', 1)`,
          [contactId, paidBy, amount, splitsJson(splits)]
        )
      ).id
    );

  const moveContactExpense = (uid, id, paidBy, amount, splits, dateSql) =>
    asUser(uid, () =>
      db.query(
        `select public.update_contact_expense_with_splits($1, $2, $3, 'ce', null, 'exact', $4::jsonb, ${dateSql}, 'USD', 1)`,
        [id, paidBy, amount, splitsJson(splits)]
      )
    );

  const addContactPayment = (uid, contactId, paidBy, paidTo, amount, dateSql) =>
    asUser(uid, async () =>
      (
        await one(
          `select id from public.create_contact_payment($1, $2, $3, $4, null, null, ${dateSql})`,
          [contactId, paidBy, paidTo, amount]
        )
      ).id
    );

  const moveContactPayment = (uid, id, paidBy, paidTo, amount, dateSql) =>
    asUser(uid, () =>
      db.query(`select public.update_contact_payment($1, $2, $3, $4, null, ${dateSql})`, [
        id,
        paidBy,
        paidTo,
        amount,
      ])
    );

  const befriend = async (a, b, bEmail) => {
    await asUser(a, () => db.query(`select public.send_contact_request($1)`, [bEmail]));
    await asUser(b, async () => {
      const request = await one(
        `select id from public.get_contact_requests() where direction = 'incoming' and user_id = $1`,
        [a]
      );
      await db.query(`select public.respond_contact_request($1, true)`, [request.id]);
    });
  };

  const balances = (uid, groupId) =>
    asUser(uid, async () => {
      const { rows } = await db.query(
        `select user_id, balance from public.get_group_balances($1)`,
        [groupId]
      );
      return canon(Object.fromEntries(rows.map((r) => [r.user_id, r.balance])));
    });

  const edges = (uid, fn, groupId) =>
    asUser(uid, async () => {
      const { rows } = await db.query(
        `select from_name, to_name, amount from public.${fn}($1)`,
        [groupId]
      );
      return JSON.stringify(
        rows.map((r) => `${r.from_name}>${r.to_name}:${Number(r.amount)}`).sort()
      );
    });

  const ledgerChecks = async (label, uid, groupId, expected) => {
    check(
      (await balances(uid, groupId)) === canon(expected.balances),
      `${label}: get_group_balances is ${JSON.stringify(Object.values(expected.balances))}`
    );
    check(
      (await edges(uid, "get_group_pairwise_balances", groupId)) ===
        JSON.stringify([...expected.pairwise].sort()),
      `${label}: get_group_pairwise_balances is ${JSON.stringify(expected.pairwise)}`
    );
    check(
      (await edges(uid, "get_group_simplified_edges", groupId)) ===
        JSON.stringify([...expected.simplified].sort()),
      `${label}: get_group_simplified_edges is ${JSON.stringify(expected.simplified)}`
    );
  };

  const userTotal = (uid) =>
    asUser(uid, async () =>
      sortedNumbers(
        (await db.query(`select balance from public.get_user_total_balance($1)`, [uid])).rows
      )
    );

  // ---- Group balances, pairwise and simplified edges ----------------------
  const gina = await signUp("gina.future@example.com", "Gina");
  const hank = await signUp("hank.future@example.com", "Hank");
  const ivy = await signUp("ivy.future@example.com", "Ivy");
  const stranger = await signUp("stan.future@example.com", "Stan");
  const groupG = await createGroup(gina, "Future G", [
    "hank.future@example.com",
    "ivy.future@example.com",
  ]);

  const e1 = await addExpense(gina, groupG, gina, 30, [[gina, 10], [hank, 10], [ivy, 10]], IN_2D);
  await ledgerChecks("a future expense alone", hank, groupG, {
    balances: { [gina]: 0, [hank]: 0, [ivy]: 0 },
    pairwise: [],
    simplified: [],
  });

  await addExpense(gina, groupG, gina, 20, [[gina, 10], [hank, 10]], AGO_1D);
  await ledgerChecks("plus a past expense", hank, groupG, {
    balances: { [gina]: 10, [hank]: -10, [ivy]: 0 },
    pairwise: ["Hank>Gina:10"],
    simplified: ["Hank>Gina:10"],
  });

  await addExpense(hank, groupG, hank, 4, [[hank, 2], [ivy, 2]], NOW);
  const afterNowExpense = {
    balances: { [gina]: 10, [hank]: -8, [ivy]: -2 },
    pairwise: ["Hank>Gina:10", "Ivy>Hank:2"],
    simplified: ["Hank>Gina:8", "Ivy>Gina:2"],
  };
  await ledgerChecks("plus an expense dated now", ivy, groupG, afterNowExpense);

  const p1 = await addPayment(hank, groupG, hank, gina, 8, IN_2D);
  await ledgerChecks("plus a future payment (no change)", gina, groupG, afterNowExpense);

  await addPayment(hank, groupG, hank, gina, 3, NOW);
  const afterNowPayment = {
    balances: { [gina]: 7, [hank]: -5, [ivy]: -2 },
    pairwise: ["Hank>Gina:7", "Ivy>Hank:2"],
    simplified: ["Hank>Gina:5", "Ivy>Gina:2"],
  };
  await ledgerChecks("plus a payment dated now", gina, groupG, afterNowPayment);
  check((await userTotal(ivy)) === "[-2]", "get_user_total_balance leaves out Ivy's future split");

  // ---- Activity feed and upcoming ----------------------------------------
  const e4 = await addExpense(gina, groupG, gina, 6, [[gina, 3], [hank, 3]], IN_5D);
  const e5 = await addExpense(gina, groupG, gina, 2, [[gina, 1], [ivy, 1]], IN_1D);
  await ledgerChecks("two more future expenses (no change)", gina, groupG, afterNowPayment);

  const recentIds = (uid, limit) =>
    asUser(uid, async () =>
      (await db.query(`select id from public.get_recent_activity($1)`, [limit])).rows.map(
        (r) => r.id
      )
    );
  const upcoming = (uid, limit) =>
    asUser(uid, async () =>
      (await db.query(`select * from public.get_upcoming_expenses($1)`, [limit])).rows
    );

  const ginaRecent = await recentIds(gina, 50);
  check(
    ginaRecent.length === 1 && ![e1, e4, e5].some((id) => ginaRecent.includes(id)),
    "get_recent_activity leaves out future expenses"
  );
  const ginaRecentOne = await recentIds(gina, 1);
  check(
    ginaRecentOne.length === 1 && !ginaRecentOne.includes(e4),
    "a future expense cannot take get_recent_activity's slots (limit 1 returns the past one)"
  );

  const ginaUpcoming = await upcoming(gina, 50);
  check(
    JSON.stringify(ginaUpcoming.map((r) => r.id)) === JSON.stringify([e5, e1, e4]),
    "get_upcoming_expenses returns only future expenses, soonest first"
  );
  check(
    ginaUpcoming[0].groups?.name === "Future G" &&
      ginaUpcoming[0].payer?.id === gina &&
      ginaUpcoming[0].expense_splits.length === 2,
    "get_upcoming_expenses rows carry the same payer/groups/expense_splits shape"
  );
  check(
    JSON.stringify((await upcoming(gina, 1)).map((r) => r.id)) === JSON.stringify([e5]),
    "get_upcoming_expenses honours p_limit"
  );
  check(
    JSON.stringify((await upcoming(ivy, 50)).map((r) => r.id)) === JSON.stringify([e5, e1]),
    "get_upcoming_expenses shows a member only expenses they paid or share in"
  );
  check((await upcoming(stranger, 50)).length === 0, "get_upcoming_expenses shows a non-member nothing");
  check(
    (await errorOf(db.query(`select * from public.get_upcoming_expenses()`))) ===
      "Not authenticated",
    "get_upcoming_expenses needs a signed-in user"
  );

  const shape = await db.query(
    `select p.proname, pg_get_function_result(p.oid) as result,
       coalesce(p.proacl::text, '') as acl,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('get_recent_activity', 'get_upcoming_expenses')`
  );
  const recentFn = shape.rows.filter((r) => r.proname === "get_recent_activity");
  const upcomingFn = shape.rows.filter((r) => r.proname === "get_upcoming_expenses");
  check(
    recentFn.length === 1 &&
      upcomingFn.length === 1 &&
      upcomingFn[0].result === recentFn[0].result &&
      upcomingFn[0].acl === recentFn[0].acl &&
      upcomingFn[0].auth_exec,
    "exactly one get_upcoming_expenses, with get_recent_activity's columns and grants"
  );

  // ---- Moving a row into the past makes it count --------------------------
  await movePayment(hank, p1, hank, gina, 8, AGO_1H);
  await ledgerChecks("after the future payment is moved into the past", ivy, groupG, {
    balances: { [gina]: -1, [hank]: 3, [ivy]: -2 },
    pairwise: ["Gina>Hank:1", "Ivy>Hank:2"],
    simplified: ["Gina>Hank:1", "Ivy>Hank:2"],
  });

  await moveExpense(ivy, e1, gina, 30, [[gina, 10], [hank, 10], [ivy, 10]], AGO_1H);
  check(
    (await balances(gina, groupG)) === canon({ [gina]: 19, [hank]: -7, [ivy]: -12 }),
    "after the future expense is moved into the past, get_group_balances counts it"
  );
  check((await userTotal(ivy)) === "[-12]", "get_user_total_balance counts the moved expense");
  check(
    (await recentIds(gina, 50)).includes(e1) &&
      !(await upcoming(gina, 50)).some((r) => r.id === e1),
    "the moved expense leaves get_upcoming_expenses for get_recent_activity"
  );

  // ---- Contacts: ledger, shared-group breakdown, combined -----------------
  const kim = await signUp("kim.future@example.com", "Kim");
  const lou = await signUp("lou.future@example.com", "Lou");
  await befriend(kim, lou, "lou.future@example.com");

  const groupD = await createGroup(kim, "KL Direct", ["lou.future@example.com"]);
  await asUser(kim, () => db.query(`select public.set_group_simplify_debts($1, false)`, [groupD]));
  const groupS = await createGroup(kim, "KL Simple", ["lou.future@example.com"]);
  const groupPayments = {};
  for (const groupId of [groupD, groupS]) {
    await addExpense(kim, groupId, kim, 10, [[kim, 5], [lou, 5]], IN_2D);
    await addExpense(kim, groupId, kim, 6, [[kim, 3], [lou, 3]], AGO_1D);
    groupPayments[groupId] = await addPayment(lou, groupId, lou, kim, 3, IN_2D);
  }

  const ce1 = await addContactExpense(kim, lou, kim, 40, [[kim, 20], [lou, 20]], IN_2D);
  await addContactExpense(lou, kim, lou, 10, [[kim, 5], [lou, 5]], AGO_1D);
  const cp1 = await addContactPayment(kim, lou, kim, lou, 7, IN_2D);
  await addContactPayment(lou, kim, lou, kim, 1, NOW);

  const contactBalance = () =>
    asUser(kim, async () =>
      Number((await one(`select public.get_contact_balance($1) as b`, [lou])).b)
    );
  const contactsWithBalances = () =>
    asUser(kim, async () =>
      sortedNumbers(
        (
          await db.query(
            `select balance from public.get_contacts_with_balances() where contact_user_id = $1`,
            [lou]
          )
        ).rows
      )
    );
  const combined = () =>
    asUser(kim, async () =>
      sortedNumbers(
        (
          await db.query(
            `select balance from public.get_contacts_with_combined_balances() where contact_user_id = $1`,
            [lou]
          )
        ).rows
      )
    );
  const breakdown = () =>
    asUser(kim, async () =>
      JSON.stringify(
        (
          await db.query(`select group_name, balance from public.get_contact_group_breakdown($1)`, [
            lou,
          ])
        ).rows.map((r) => `${r.group_name}:${Number(r.balance)}`)
      )
    );

  check((await contactBalance()) === -6, "get_contact_balance leaves out the future contact expense and payment");
  check((await contactsWithBalances()) === "[-6]", "get_contacts_with_balances leaves them out");
  check(
    (await breakdown()) === JSON.stringify(["KL Direct:3", "KL Simple:3"]),
    "get_contact_group_breakdown leaves out future group rows (direct and simplified groups)"
  );
  check(
    (await combined()) === "[-6,3,3]",
    "get_contacts_with_combined_balances leaves out every future row"
  );
  check((await userTotal(kim)) === "[-6,3,3]", "get_user_total_balance leaves out future contact rows");

  await moveContactExpense(lou, ce1, kim, 40, [[kim, 20], [lou, 20]], AGO_1H);
  check((await contactBalance()) === 14, "a contact expense moved into the past counts");
  await moveContactPayment(lou, cp1, kim, lou, 7, AGO_1H);
  check((await contactBalance()) === 21, "a contact payment moved into the past counts");
  check((await contactsWithBalances()) === "[21]", "get_contacts_with_balances counts the moved rows");
  await movePayment(lou, groupPayments[groupD], lou, kim, 3, AGO_1H);
  await movePayment(kim, groupPayments[groupS], lou, kim, 3, AGO_1H);
  check(
    (await breakdown()) === "[]",
    "get_contact_group_breakdown counts group payments moved into the past (both groups settle)"
  );
  check((await combined()) === "[21]", "get_contacts_with_combined_balances counts the moved rows");
  check((await userTotal(kim)) === "[0,0,21]", "get_user_total_balance counts the moved rows");

  // ---- leave_group refuses while upcoming rows involve the member ---------
  const mia = await signUp("mia.future@example.com", "Mia");
  const ned = await signUp("ned.future@example.com", "Ned");
  const oz = await signUp("oz.future@example.com", "Oz");
  const groupL = await createGroup(mia, "Leave L", ["ned.future@example.com", "oz.future@example.com"]);
  const isMember = async (uid, groupId) =>
    (
      await db.query(`select 1 from public.group_members where group_id = $1 and user_id = $2`, [
        groupId,
        uid,
      ])
    ).rows.length === 1;
  const leave = (uid, groupId) =>
    asUser(uid, () => errorOf(db.query(`select public.leave_group($1)`, [groupId])));

  const le = await addExpense(ned, groupL, ned, 10, [[mia, 5], [ned, 5]], IN_2D);
  check((await leave(mia, groupL)) === LEAVE_MSG, "leave_group refuses a member with a future split");
  check((await leave(ned, groupL)) === LEAVE_MSG, "leave_group refuses the payer of a future expense");
  check(await isMember(mia, groupL), "the refused member is still in the group");
  await asUser(mia, () => db.query(`select public.delete_expense($1)`, [le]));
  check((await leave(mia, groupL)) === null && !(await isMember(mia, groupL)), "after the future expense is deleted the member can leave");

  const lp = await addPayment(ned, groupL, ned, oz, 5, IN_2D);
  check((await leave(oz, groupL)) === LEAVE_MSG, "leave_group refuses the recipient of a future payment");
  check((await leave(ned, groupL)) === LEAVE_MSG, "leave_group refuses the sender of a future payment");
  await asUser(oz, () => db.query(`select public.delete_payment($1)`, [lp]));
  check((await leave(oz, groupL)) === null && !(await isMember(oz, groupL)), "after the future payment is deleted the member can leave");

  const pia = await signUp("pia.future@example.com", "Pia");
  const ray = await signUp("ray.future@example.com", "Ray");
  const groupL2 = await createGroup(pia, "Leave L2", ["ray.future@example.com"]);
  await addExpense(pia, groupL2, pia, 10, [[pia, 5], [ray, 5]], AGO_1D);
  check(
    (await leave(ray, groupL2)) === "Settle your outstanding balance before leaving this group",
    "leave_group still refuses an unsettled past balance with its own message"
  );
  check(
    (await leave(stranger, groupL2)) === "You are not a member of this group",
    "leave_group still refuses a non-member"
  );

  // The last member leaving deletes the group and its rows; nobody is left to owe.
  const groupL3 = await createGroup(pia, "Leave L3", []);
  await addExpense(pia, groupL3, pia, 5, [[pia, 5]], IN_2D);
  check(
    (await leave(pia, groupL3)) === null &&
      (await db.query(`select 1 from public.groups where id = $1`, [groupL3])).rows.length === 0,
    "the last member can still leave (deleting the group) with a future row"
  );

  // The guard and get_upcoming_expenses agree on who a future expense involves:
  // the payer (even with no split row) and anyone with a non-zero split. A
  // member it blocks can find the row to cancel; one it lists nothing for can go.
  const quinn = await signUp("quinn.future@example.com", "Quinn");
  const wes = await signUp("wes.future@example.com", "Wes");
  const xan = await signUp("xan.future@example.com", "Xan");
  const groupP = await createGroup(quinn, "Leave Parity", [
    "wes.future@example.com",
    "xan.future@example.com",
  ]);
  const pe = await addExpense(quinn, groupP, quinn, 10, [[wes, 10], [xan, 0]], IN_2D);
  const listsPe = async (uid) => (await upcoming(uid, 50)).some((r) => r.id === pe);
  check(
    (await db.query(`select 1 from public.expense_splits where expense_id = $1 and user_id = $2`, [pe, quinn]))
      .rows.length === 0,
    "the parity expense's payer has no split row"
  );
  check(
    (await leave(quinn, groupP)) === LEAVE_MSG && (await listsPe(quinn)),
    "the payer of a future expense with no split of their own is refused, and it is in their upcoming list"
  );
  check(
    (await leave(wes, groupP)) === LEAVE_MSG && (await listsPe(wes)),
    "a member with a non-zero future split is refused, and it is in their upcoming list"
  );
  check(!(await listsPe(xan)), "a 0.00 future split is not in that member's upcoming list");
  check(
    (await leave(xan, groupP)) === null && !(await isMember(xan, groupP)),
    "a member whose only future split is 0.00 can leave"
  );

  // ---- Currency guards count future rows ---------------------------------
  const sam = await signUp("sam.future@example.com", "Sam");
  const tia = await signUp("tia.future@example.com", "Tia");
  const uma = await signUp("uma.future@example.com", "Uma");
  const groupC1 = await createGroup(sam, "Currency C1", ["tia.future@example.com"]);
  await addExpense(sam, groupC1, sam, 10, [[sam, 5], [tia, 5]], IN_2D);
  const groupC2 = await createGroup(sam, "Currency C2", ["tia.future@example.com"]);
  await addPayment(sam, groupC2, sam, tia, 5, IN_2D);
  for (const [label, groupId] of [["expense", groupC1], ["payment", groupC2]]) {
    check(
      (await asUser(sam, () =>
        errorOf(db.query(`select public.set_group_currency($1, 'EUR')`, [groupId]))
      )) === "Cannot change group currency after activity exists",
      `set_group_currency refuses while only a future ${label} exists`
    );
  }

  await befriend(sam, tia, "tia.future@example.com");
  await addContactExpense(sam, tia, sam, 10, [[sam, 5], [tia, 5]], IN_2D);
  await befriend(sam, uma, "uma.future@example.com");
  await addContactPayment(sam, uma, sam, uma, 5, IN_2D);
  for (const [label, other] of [["contact expense", tia], ["contact payment", uma]]) {
    check(
      (await asUser(sam, () =>
        errorOf(db.query(`select public.set_contact_currency($1, 'EUR')`, [other]))
      )) === "Cannot change contact currency after activity exists",
      `set_contact_currency refuses while only a future ${label} exists`
    );
  }
};
