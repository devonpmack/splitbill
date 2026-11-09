// The two expense-update bodies live in private helpers that take the acting
// user as a parameter (the recurring update has no JWT) and say whether the edit
// counts as a hand edit. The public update RPCs keep their behaviour and become
// thin wrappers that always mark a schedule-linked row as hand_edited; the
// recurring update calls the helpers with false so a schedule rewrite never
// freezes its own series.

export default async function updateHelpers({ db, asUser, signUp, rejects, check }) {
  const dan = await signUp("uh-dan@example.com", "Dan");
  const erin = await signUp("uh-erin@example.com", "Erin");
  const fay = await signUp("uh-fay@example.com", "Fay");
  const hal = await signUp("uh-hal@example.com", "Hal");
  const ivy = await signUp("uh-ivy@example.com", "Ivy");

  const message = async (fn) => {
    try {
      await fn();
      return "(no error)";
    } catch (error) {
      return error.message;
    }
  };
  const code = async (fn) => {
    try {
      await fn();
      return "(no error)";
    } catch (error) {
      return error.code;
    }
  };
  // uid null runs as the owner with no JWT, as cron does.
  const run = (uid, fn) => (uid ? asUser(uid, fn) : fn());

  // ---- Shape of the functions ------------------------------------------------
  const { rows: helperRows } = await db.query(`
    select p.proname, p.prosecdef, p.proconfig, pg_get_function_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('_update_group_expense', '_update_contact_expense')
    order by 1
  `);
  check(
    helperRows.map((r) => r.proname).join(",") === "_update_contact_expense,_update_group_expense",
    "exactly one _update_group_expense and one _update_contact_expense exist"
  );
  check(
    helperRows.every(
      (r) =>
        r.prosecdef &&
        (r.proconfig ?? []).includes("search_path=public, pg_temp") &&
        r.args.startsWith("p_actor uuid, p_expense_id uuid") &&
        r.args.endsWith("p_mark_hand_edited boolean DEFAULT true")
    ),
    "both update helpers are SECURITY DEFINER with search_path = public, pg_temp, take p_actor first and p_mark_hand_edited last (default true)"
  );

  const { rows: overloads } = await db.query(`
    select p.proname, count(*)::int as n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('update_expense_with_splits', 'update_contact_expense_with_splits')
    group by 1 order by 1
  `);
  check(
    overloads.length === 2 && overloads.every((r) => r.n === 1),
    "the update RPCs have exactly one signature each (no leftover overload)"
  );
  const { rows: wrappers } = await db.query(`
    select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as authed,
      has_function_privilege('anon', p.oid, 'execute') as anon, p.prosecdef,
      pg_get_function_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('update_expense_with_splits', 'update_contact_expense_with_splits')
  `);
  check(
    wrappers.length === 2 &&
      wrappers.every((r) => r.authed && r.anon && r.prosecdef && !r.args.includes("p_actor") && !r.args.includes("p_mark_hand_edited")),
    "the public update RPCs keep their signature, stay SECURITY DEFINER and executable like before"
  );
  const { rows: exposed } = await db.query(`
    select p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and left(p.proname, 1) = '_'
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))
  `);
  check(exposed.length === 0, "no private function (including the update helpers) is executable by clients");

  // ---- Fixtures --------------------------------------------------------------
  const groupId = await asUser(dan, async () => {
    const { rows } = await db.query(
      `select * from public.create_group_with_members('Flat', array['uh-erin@example.com'], 'USD')`
    );
    return rows[0].id;
  });
  await asUser(hal, () => db.query(`select public.send_contact_request('uh-ivy@example.com')`));
  const { rows: reqRows } = await db.query(
    `select id from public.contact_requests where requester_id = $1`,
    [hal]
  );
  await asUser(ivy, () =>
    db.query(`select public.respond_contact_request($1, true)`, [reqRows[0].id])
  );
  const [lo, hi] = hal < ivy ? [hal, ivy] : [ivy, hal];

  const half = (a, b, amount = 15, base = amount) => [
    { userId: a, amount, baseAmount: base },
    { userId: b, amount, baseAmount: base },
  ];

  const insertSchedule = async (fields) => {
    const row = {
      created_by: dan, paid_by: dan, description: "Rent", amount: 30, currency: "USD",
      last_exchange_rate: 1, split_type: "equal", splits: JSON.stringify([{ userId: dan, amount: 30, baseAmount: 30 }]),
      start_date: "2027-02-01", tz: "America/Toronto", frequency: "monthly", ...fields,
    };
    const cols = Object.keys(row);
    const { rows } = await db.query(
      `insert into public.recurring_schedules (${cols.join(", ")})
       values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row)
    );
    return rows[0].id;
  };
  const gSched = await insertSchedule({ kind: "group", group_id: groupId });
  const cSched = await insertSchedule({
    kind: "contact", user_lo: lo, user_hi: hi, created_by: hal, paid_by: hal,
    splits: JSON.stringify([{ userId: hal, amount: 30, baseAmount: 30 }]),
  });

  // Rows are created through the PR #12 insert helpers, as the owner, with no JWT.
  let day = 0;
  const nextDay = () => `2027-03-${String(++day).padStart(2, "0")}`;
  const makeGroupExpense = async (scheduleId = null) => {
    const { rows } = await db.query(
      `select * from public._insert_group_expense(
         p_actor => $1::uuid, p_group_id => $2::uuid, p_paid_by => $3::uuid, p_amount => 30,
         p_description => 'Rent', p_category => null, p_split_type => 'equal', p_splits => $4::jsonb,
         p_schedule_id => $5::uuid, p_occurrence_date => $6::date)`,
      [dan, groupId, dan, JSON.stringify(half(dan, erin)), scheduleId, scheduleId ? nextDay() : null]
    );
    return rows[0];
  };
  const makeContactExpense = async (scheduleId = null) => {
    const { rows } = await db.query(
      `select * from public._insert_contact_expense(
         p_actor => $1::uuid, p_contact_user_id => $2::uuid, p_paid_by => $3::uuid, p_amount => 30,
         p_description => 'Taxi', p_category => null, p_split_type => 'equal', p_splits => $4::jsonb,
         p_schedule_id => $5::uuid, p_occurrence_date => $6::date)`,
      [hal, ivy, hal, JSON.stringify(half(hal, ivy)), scheduleId, scheduleId ? nextDay() : null]
    );
    return rows[0];
  };
  const stored = async (table, id) =>
    (await db.query(`select * from public.${table} where id = $1`, [id])).rows[0];
  const splitsOf = async (table, id) =>
    (await db.query(`select user_id, amount, base_amount from public.${table} where expense_id = $1 order by user_id`, [id])).rows;

  // ---- Public group RPC: behaviour the extraction must keep -------------------
  const groupRpc = (uid, id, o = {}) => {
    const a = {
      paidBy: dan, amount: 30, description: "Dinner", category: null, splitType: "equal",
      splits: half(dan, erin), date: null, currency: "USD", rate: 1, ...o,
    };
    return run(uid, async () => {
      const { rows } = await db.query(
        `select * from public.update_expense_with_splits($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [id, a.paidBy, a.amount, a.description, a.category, a.splitType, JSON.stringify(a.splits), a.date, a.currency, a.rate]
      );
      return rows[0];
    });
  };
  const base = await makeGroupExpense();
  const missing = "00000000-0000-4000-8000-000000000000";
  const groupErrors = [
    ["a missing user", null, base.id, {}, "Not authenticated"],
    ["an unknown expense", dan, missing, {}, "Expense not found"],
    ["a non-member caller", fay, base.id, {}, "You are not a member of this group"],
    ["a non-member payer", dan, base.id, { paidBy: fay }, "Expense payer must be a group member"],
    ["a zero amount", dan, base.id, { amount: 0 }, "Expense amount must be greater than zero"],
    ["a zero exchange rate", dan, base.id, { rate: 0 }, "Exchange rate must be greater than zero"],
    ["a blank description", dan, base.id, { description: "   " }, "Expense description is required"],
    ["a negative split", dan, base.id, { splits: [{ userId: dan, amount: -5 }, { userId: erin, amount: 35 }] }, "Split amount cannot be negative"],
    ["a non-member split user", dan, base.id, { splits: half(dan, fay) }, "Every split user must be a group member"],
    ["no splits", dan, base.id, { splits: [] }, "At least one split is required"],
    ["splits not adding up", dan, base.id, { splits: half(dan, erin, 10) }, "Split amounts must add up to the expense total"],
    ["base amounts not adding up", dan, base.id, { rate: 2 }, "Split base amounts must add up to the converted total"],
  ];
  for (const [label, uid, id, overrides, expected] of groupErrors) {
    const got = await message(() => groupRpc(uid, id, overrides));
    check(got === expected, `update_expense_with_splits rejects ${label} with "${expected}" (got: ${got})`);
  }
  const untouched = await stored("expenses", base.id);
  check(
    untouched.description === "Rent" && Number(untouched.amount) === 30 && (await splitsOf("expense_splits", base.id)).length === 2,
    "rejected group edits leave the row and its splits as they were"
  );

  const gUpdated = await groupRpc(erin, base.id, {
    paidBy: erin, amount: 30, description: "  Dinner  ", category: "food", splitType: "exact",
    currency: " eur ", rate: 1.1, date: "2027-01-01T00:00:00Z",
    splits: [{ userId: dan, amount: 10, baseAmount: 11 }, { userId: erin, amount: 20, baseAmount: 22 }],
  });
  check(
    gUpdated.id === base.id && gUpdated.group_id === groupId && gUpdated.paid_by === erin &&
      Number(gUpdated.amount) === 30 && gUpdated.description === "Dinner" && gUpdated.category === "food" &&
      gUpdated.split_type === "exact" && gUpdated.currency === "EUR" && Number(gUpdated.exchange_rate) === 1.1 &&
      Number(gUpdated.base_amount) === 33 && new Date(gUpdated.date).toISOString() === "2027-01-01T00:00:00.000Z",
    "update_expense_with_splits by any member stores the trimmed, converted row and honours p_date"
  );
  const { rows: expenseCols } = await db.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'expenses'`
  );
  check(
    Object.keys(gUpdated).sort().join() === expenseCols.map((r) => r.column_name).sort().join(),
    "update_expense_with_splits returns a full expenses row"
  );
  const gSplits = await splitsOf("expense_splits", base.id);
  check(
    gSplits.length === 2 && gSplits.map((s) => `${Number(s.amount)}/${Number(s.base_amount)}`).sort().join() === "10/11,20/22",
    "update_expense_with_splits replaces the splits with their base amounts"
  );
  const keptDate = await groupRpc(dan, base.id, { date: null });
  check(
    new Date(keptDate.date).toISOString() === "2027-01-01T00:00:00.000Z",
    "update_expense_with_splits keeps the date when p_date is null"
  );

  // ---- Public contact RPC -----------------------------------------------------
  const contactRpc = (uid, id, o = {}) => {
    const a = {
      paidBy: hal, amount: 30, description: "Taxi", category: null, splitType: "equal",
      splits: half(hal, ivy), date: null, currency: "USD", rate: 1, ...o,
    };
    return run(uid, async () => {
      const { rows } = await db.query(
        `select * from public.update_contact_expense_with_splits($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)`,
        [id, a.paidBy, a.amount, a.description, a.category, a.splitType, JSON.stringify(a.splits), a.date, a.currency, a.rate]
      );
      return rows[0];
    });
  };
  const cBase = await makeContactExpense();
  const contactErrors = [
    ["a missing user", null, cBase.id, {}, "Not authenticated"],
    ["an unknown expense", hal, missing, {}, "Expense not found"],
    ["a non-participant caller", fay, cBase.id, {}, "You are not a participant in this expense"],
    ["a payer outside the pair", hal, cBase.id, { paidBy: fay }, "Expense payer must be a participant"],
    ["a zero amount", hal, cBase.id, { amount: 0 }, "Expense amount must be greater than zero"],
    ["a zero exchange rate", hal, cBase.id, { rate: 0 }, "Exchange rate must be greater than zero"],
    ["a blank description", hal, cBase.id, { description: " " }, "Expense description is required"],
    ["a negative split", hal, cBase.id, { splits: [{ userId: hal, amount: -5 }, { userId: ivy, amount: 35 }] }, "Split amount cannot be negative"],
    ["a split user outside the pair", hal, cBase.id, { splits: half(hal, fay) }, "Every split user must be a participant"],
    ["no splits", hal, cBase.id, { splits: [] }, "At least one split is required"],
    ["splits not adding up", hal, cBase.id, { splits: half(hal, ivy, 10) }, "Split amounts must add up to the expense total"],
    ["base amounts not adding up", hal, cBase.id, { rate: 2 }, "Split base amounts must add up to the converted total"],
  ];
  for (const [label, uid, id, overrides, expected] of contactErrors) {
    const got = await message(() => contactRpc(uid, id, overrides));
    check(got === expected, `update_contact_expense_with_splits rejects ${label} with "${expected}" (got: ${got})`);
  }
  const cUntouched = await stored("contact_expenses", cBase.id);
  check(
    cUntouched.description === "Taxi" && (await splitsOf("contact_expense_splits", cBase.id)).length === 2,
    "rejected contact edits leave the row and its splits as they were"
  );

  const cUpdated = await contactRpc(ivy, cBase.id, {
    paidBy: ivy, description: " Cab ", category: "travel", splitType: "exact", currency: "cad", rate: 0.5,
    date: "2027-01-02T00:00:00Z",
    splits: [{ userId: hal, amount: 10, baseAmount: 5 }, { userId: ivy, amount: 20, baseAmount: 10 }],
  });
  check(
    cUpdated.id === cBase.id && cUpdated.user_lo === lo && cUpdated.user_hi === hi && cUpdated.paid_by === ivy &&
      cUpdated.description === "Cab" && cUpdated.split_type === "exact" && cUpdated.currency === "CAD" &&
      Number(cUpdated.base_amount) === 15 && new Date(cUpdated.date).toISOString() === "2027-01-02T00:00:00.000Z",
    "update_contact_expense_with_splits by either participant stores the trimmed, converted row and keeps the pair"
  );
  const { rows: contactCols } = await db.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'contact_expenses'`
  );
  check(
    Object.keys(cUpdated).sort().join() === contactCols.map((r) => r.column_name).sort().join(),
    "update_contact_expense_with_splits returns a full contact_expenses row"
  );
  const cSplits = await splitsOf("contact_expense_splits", cBase.id);
  check(
    cSplits.length === 2 && cSplits.map((s) => `${Number(s.amount)}/${Number(s.base_amount)}`).sort().join() === "10/5,20/10",
    "update_contact_expense_with_splits replaces the splits with their base amounts"
  );

  // ---- hand_edited through the public RPCs ----------------------------------
  check(
    gUpdated.hand_edited === false && (await stored("expenses", base.id)).hand_edited === false,
    "editing a non-scheduled group expense leaves hand_edited false"
  );
  check(
    cUpdated.hand_edited === false && (await stored("contact_expenses", cBase.id)).hand_edited === false,
    "editing a non-scheduled contact expense leaves hand_edited false"
  );

  const gOcc = await makeGroupExpense(gSched);
  check(
    gOcc.schedule_id === gSched && gOcc.hand_edited === false,
    "a freshly inserted scheduled group occurrence is not hand_edited"
  );
  check(
    (await message(() => groupRpc(dan, gOcc.id, { amount: 0 }))) === "Expense amount must be greater than zero" &&
      (await stored("expenses", gOcc.id)).hand_edited === false,
    "a rejected edit of a scheduled group row does not mark it hand_edited"
  );
  const gEdited = await groupRpc(erin, gOcc.id, { description: "Rent (edited)" });
  check(
    gEdited.hand_edited === true && (await stored("expenses", gOcc.id)).hand_edited === true,
    "editing a scheduled group row through update_expense_with_splits marks it hand_edited (returned and stored)"
  );
  const gEditedAgain = await groupRpc(dan, gOcc.id, { description: "Rent (edited twice)" });
  check(gEditedAgain.hand_edited === true, "a hand-edited group row stays hand_edited");

  const cOcc = await makeContactExpense(cSched);
  const cEdited = await contactRpc(ivy, cOcc.id, { description: "Taxi (edited)" });
  check(
    cOcc.hand_edited === false && cEdited.hand_edited === true &&
      (await stored("contact_expenses", cOcc.id)).hand_edited === true,
    "editing a scheduled contact row through update_contact_expense_with_splits marks it hand_edited"
  );

  // ---- The helpers: not for clients ------------------------------------------
  const groupHelperCall = `select public._update_group_expense($1::uuid, $2::uuid, $3::uuid, 30, 'X', null, 'equal', $4::jsonb)`;
  const groupHelperArgs = [dan, base.id, dan, JSON.stringify(half(dan, erin))];
  const contactHelperCall = `select public._update_contact_expense($1::uuid, $2::uuid, $3::uuid, 30, 'X', null, 'equal', $4::jsonb)`;
  const contactHelperArgs = [hal, cBase.id, hal, JSON.stringify(half(hal, ivy))];
  check(
    (await code(() => asUser(dan, () => db.query(groupHelperCall, groupHelperArgs)))) === "42501",
    "authenticated calling _update_group_expense is permission denied (42501)"
  );
  check(
    (await code(() => asUser(hal, () => db.query(contactHelperCall, contactHelperArgs)))) === "42501",
    "authenticated calling _update_contact_expense is permission denied (42501)"
  );
  await db.exec("set role anon");
  const anonGroup = await code(() => db.query(groupHelperCall, groupHelperArgs));
  const anonContact = await code(() => db.query(contactHelperCall, contactHelperArgs));
  await db.exec("reset role");
  check(anonGroup === "42501", "anon calling _update_group_expense is permission denied (42501)");
  check(anonContact === "42501", "anon calling _update_contact_expense is permission denied (42501)");

  // ---- The helpers called directly as the owner, with no JWT ------------------
  const noJwt = await db.query(`select auth.uid() as uid`);
  check(noJwt.rows[0].uid === null, "the helper checks below run with no JWT (auth.uid() is null)");

  const groupHelper = (id, o = {}) => {
    const a = {
      actor: dan, paidBy: dan, amount: 30, description: "Rent", splits: half(dan, erin), mark: undefined, ...o,
    };
    const flag = a.mark === undefined ? "" : `, p_mark_hand_edited => ${a.mark}`;
    return db
      .query(
        `select * from public._update_group_expense(
           p_actor => $1::uuid, p_expense_id => $2::uuid, p_paid_by => $3::uuid, p_amount => $4::numeric,
           p_description => $5::text, p_category => null, p_split_type => 'equal', p_splits => $6::jsonb${flag})`,
        [a.actor, id, a.paidBy, a.amount, a.description, JSON.stringify(a.splits)]
      )
      .then((r) => r.rows[0]);
  };
  const contactHelper = (id, o = {}) => {
    const a = {
      actor: hal, paidBy: hal, amount: 30, description: "Taxi", splits: half(hal, ivy), mark: undefined, ...o,
    };
    const flag = a.mark === undefined ? "" : `, p_mark_hand_edited => ${a.mark}`;
    return db
      .query(
        `select * from public._update_contact_expense(
           p_actor => $1::uuid, p_expense_id => $2::uuid, p_paid_by => $3::uuid, p_amount => $4::numeric,
           p_description => $5::text, p_category => null, p_split_type => 'equal', p_splits => $6::jsonb${flag})`,
        [a.actor, id, a.paidBy, a.amount, a.description, JSON.stringify(a.splits)]
      )
      .then((r) => r.rows[0]);
  };

  // p_mark_hand_edited = false never marks; two successive edits both apply (B2).
  const gSeries = await makeGroupExpense(gSched);
  const first = await groupHelper(gSeries.id, { mark: false, amount: 40, description: "Rent v2", splits: half(dan, erin, 20) });
  const second = await groupHelper(gSeries.id, { mark: false, amount: 50, description: "Rent v3", splits: half(dan, erin, 25) });
  const gSeriesRow = await stored("expenses", gSeries.id);
  check(
    first.hand_edited === false && second.hand_edited === false && gSeriesRow.hand_edited === false,
    "_update_group_expense(p_mark_hand_edited => false) leaves a scheduled row hand_edited = false"
  );
  check(
    Number(first.amount) === 40 && first.description === "Rent v2" &&
      Number(second.amount) === 50 && second.description === "Rent v3" &&
      Number(gSeriesRow.amount) === 50 && gSeriesRow.description === "Rent v3" &&
      (await splitsOf("expense_splits", gSeries.id)).every((s) => Number(s.amount) === 25),
    "two successive _update_group_expense(false) edits both rewrite the row and its splits"
  );
  const cSeries = await makeContactExpense(cSched);
  const cFirst = await contactHelper(cSeries.id, { mark: false, amount: 40, description: "Taxi v2", splits: half(hal, ivy, 20) });
  const cSecond = await contactHelper(cSeries.id, { mark: false, amount: 50, description: "Taxi v3", splits: half(hal, ivy, 25) });
  const cSeriesRow = await stored("contact_expenses", cSeries.id);
  check(
    cFirst.hand_edited === false && cSecond.hand_edited === false && cSeriesRow.hand_edited === false,
    "_update_contact_expense(p_mark_hand_edited => false) leaves a scheduled row hand_edited = false"
  );
  check(
    Number(cFirst.amount) === 40 && Number(cSecond.amount) === 50 && Number(cSeriesRow.amount) === 50 &&
      cSeriesRow.description === "Taxi v3" &&
      (await splitsOf("contact_expense_splits", cSeries.id)).every((s) => Number(s.amount) === 25),
    "two successive _update_contact_expense(false) edits both rewrite the row and its splits"
  );

  // false never clears a mark that a member's edit already set.
  const keptMark = await groupHelper(gOcc.id, { mark: false, description: "Rent v4" });
  check(
    keptMark.hand_edited === true && keptMark.description === "Rent v4",
    "_update_group_expense(false) does not clear an existing hand_edited mark"
  );
  const cKeptMark = await contactHelper(cOcc.id, { mark: false, description: "Taxi v4" });
  check(
    cKeptMark.hand_edited === true && cKeptMark.description === "Taxi v4",
    "_update_contact_expense(false) does not clear an existing hand_edited mark"
  );

  // true marks a scheduled row only; the parameter defaults to true.
  const gTrue = await makeGroupExpense(gSched);
  const gTrueRow = await groupHelper(gTrue.id, { mark: true });
  check(gTrueRow.hand_edited === true, "_update_group_expense(true) marks a scheduled row hand_edited");
  const gDefault = await makeGroupExpense(gSched);
  const gDefaultRow = await groupHelper(gDefault.id);
  check(gDefaultRow.hand_edited === true, "_update_group_expense marks a scheduled row when p_mark_hand_edited is omitted");
  const gPlain = await makeGroupExpense();
  const gPlainRow = await groupHelper(gPlain.id, { mark: true });
  check(
    gPlainRow.hand_edited === false && (await stored("expenses", gPlain.id)).hand_edited === false,
    "_update_group_expense(true) leaves a non-scheduled row hand_edited = false"
  );
  const cTrue = await makeContactExpense(cSched);
  const cTrueRow = await contactHelper(cTrue.id, { mark: true });
  check(cTrueRow.hand_edited === true, "_update_contact_expense(true) marks a scheduled row hand_edited");
  const cDefault = await makeContactExpense(cSched);
  check(
    (await contactHelper(cDefault.id)).hand_edited === true,
    "_update_contact_expense marks a scheduled row when p_mark_hand_edited is omitted"
  );
  const cPlain = await makeContactExpense();
  check(
    (await contactHelper(cPlain.id, { mark: true })).hand_edited === false &&
      (await stored("contact_expenses", cPlain.id)).hand_edited === false,
    "_update_contact_expense(true) leaves a non-scheduled row hand_edited = false"
  );

  // The helpers honour p_actor, not auth.uid().
  const gTarget = await makeGroupExpense();
  check(
    (await message(() => groupHelper(gTarget.id, { actor: fay }))) === "You are not a member of this group",
    "_update_group_expense checks membership of p_actor"
  );
  check(await rejects(groupHelper(gTarget.id, { actor: null })), "_update_group_expense rejects a null p_actor");
  check(
    (await message(() => groupHelper(missing))) === "Expense not found",
    "_update_group_expense keeps Expense not found"
  );
  check(
    (await message(() => groupHelper(gTarget.id, { amount: 0 }))) === "Expense amount must be greater than zero",
    "_update_group_expense keeps the amount validation"
  );
  check(
    (await groupHelper(gTarget.id, { actor: erin, paidBy: erin, description: "By Erin" })).paid_by === erin,
    "_update_group_expense edits on behalf of the p_actor it is given, with no JWT"
  );
  await db.exec(`select set_config('request.jwt.claim.sub', '${fay}', false)`);
  const foreignJwt = await message(() => groupHelper(gTarget.id, { actor: dan }));
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
  check(
    foreignJwt === "(no error)",
    "_update_group_expense ignores auth.uid(): a stranger's JWT does not block a member actor"
  );

  const cTarget = await makeContactExpense();
  check(
    (await message(() => contactHelper(cTarget.id, { actor: fay }))) === "You are not a participant in this expense",
    "_update_contact_expense checks the participants against p_actor"
  );
  check(await rejects(contactHelper(cTarget.id, { actor: null })), "_update_contact_expense rejects a null p_actor");
  check(
    (await message(() => contactHelper(missing))) === "Expense not found",
    "_update_contact_expense keeps Expense not found"
  );
  check(
    (await contactHelper(cTarget.id, { actor: ivy, paidBy: ivy, description: "By Ivy" })).paid_by === ivy,
    "_update_contact_expense edits on behalf of the p_actor it is given, with no JWT"
  );
  await db.exec(`select set_config('request.jwt.claim.sub', '${fay}', false)`);
  const cForeignJwt = await message(() => contactHelper(cTarget.id, { actor: hal }));
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
  check(
    cForeignJwt === "(no error)",
    "_update_contact_expense ignores auth.uid(): a stranger's JWT does not block a participant actor"
  );
}
