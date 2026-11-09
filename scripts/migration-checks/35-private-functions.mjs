// Private (underscore) functions: none may be callable by anon or authenticated,
// so a client cannot reach them through PostgREST. This piece extracts the two
// expense-insert helpers from the create RPCs; the RPCs keep their behaviour and
// the helpers take the acting user as a parameter (the engine has no JWT).

export default async function privateFunctions({ db, asUser, signUp, rejects, check }) {
  const dan = await signUp("pf-dan@example.com", "Dan");
  const erin = await signUp("pf-erin@example.com", "Erin");
  const fay = await signUp("pf-fay@example.com", "Fay");
  const hal = await signUp("pf-hal@example.com", "Hal");
  const ivy = await signUp("pf-ivy@example.com", "Ivy");

  // Every public function named with a leading underscore is private.
  const { rows: exposed } = await db.query(`
    select p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and left(p.proname, 1) = '_'
      and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'))
    order by 1
  `);
  check(
    exposed.length === 0,
    `no public function starting with _ is executable by anon or authenticated${
      exposed.length ? `: ${exposed.map((r) => r.sig).join("; ")}` : ""
    }`
  );

  const { rows: helpers } = await db.query(`
    select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('_insert_group_expense', '_insert_contact_expense')
    order by 1
  `);
  check(
    helpers.map((r) => r.proname).join(",") === "_insert_contact_expense,_insert_group_expense",
    "exactly one _insert_group_expense and one _insert_contact_expense exist"
  );

  const { rows: overloads } = await db.query(`
    select p.proname, count(*)::int as n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_expense_with_splits', 'create_contact_expense_with_splits')
    group by 1 order by 1
  `);
  check(
    overloads.length === 2 && overloads.every((r) => r.n === 1),
    "the create RPCs have exactly one signature each (no leftover overload)"
  );

  const { rows: wrappers } = await db.query(`
    select p.proname, has_function_privilege('authenticated', p.oid, 'execute') as authed,
      has_function_privilege('anon', p.oid, 'execute') as anon, p.prosecdef
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_expense_with_splits', 'create_contact_expense_with_splits')
  `);
  check(
    wrappers.length === 2 && wrappers.every((r) => r.authed && r.anon && r.prosecdef),
    "the public create RPCs stay SECURITY DEFINER and executable like before"
  );

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

  // Fixtures.
  const groupId = await asUser(dan, async () => {
    const { rows } = await db.query(
      `select * from public.create_group_with_members('Flat', array['pf-erin@example.com'], 'USD')`
    );
    return rows[0].id;
  });
  await asUser(hal, () => db.query(`select public.send_contact_request('pf-ivy@example.com')`));
  const { rows: reqRows } = await db.query(
    `select id from public.contact_requests where requester_id = $1`,
    [hal]
  );
  await asUser(ivy, () =>
    db.query(`select public.respond_contact_request($1, true)`, [reqRows[0].id])
  );

  const half = (a, b, amount = 15, base = amount) => [
    { userId: a, amount, baseAmount: base },
    { userId: b, amount, baseAmount: base },
  ];

  // The helpers cannot be called by clients.
  const groupHelperCall = `select public._insert_group_expense($1::uuid, $2::uuid, $3::uuid, 30, 'Dinner', null, 'equal', $4::jsonb)`;
  const groupHelperArgs = [erin, groupId, erin, JSON.stringify(half(dan, erin))];
  const contactHelperCall = `select public._insert_contact_expense($1::uuid, $2::uuid, $3::uuid, 30, 'Dinner', null, 'equal', $4::jsonb)`;
  const contactHelperArgs = [hal, ivy, hal, JSON.stringify(half(hal, ivy))];
  check(
    (await code(() => asUser(erin, () => db.query(groupHelperCall, groupHelperArgs)))) === "42501",
    "authenticated calling _insert_group_expense is permission denied (42501)"
  );
  check(
    (await code(() => asUser(hal, () => db.query(contactHelperCall, contactHelperArgs)))) === "42501",
    "authenticated calling _insert_contact_expense is permission denied (42501)"
  );
  await db.exec("set role anon");
  const anonCode = await code(() => db.query(groupHelperCall, groupHelperArgs));
  await db.exec("reset role");
  check(anonCode === "42501", "anon calling _insert_group_expense is permission denied (42501)");

  // ---- Group RPC: behaviour the extraction must keep -----------------------
  const groupRpc = (uid, o = {}) => {
    const a = {
      group: groupId, paidBy: dan, amount: 30, description: "Dinner", category: null,
      splits: half(dan, erin), date: null, currency: "USD", rate: 1, ...o,
    };
    return run(uid, async () => {
      const { rows } = await db.query(
        `select * from public.create_expense_with_splits($1, $2, $3, $4, $5, 'equal', $6::jsonb, $7, $8, $9)`,
        [a.group, a.paidBy, a.amount, a.description, a.category, JSON.stringify(a.splits), a.date, a.currency, a.rate]
      );
      return rows[0];
    });
  };
  const groupErrors = [
    ["a missing user", null, {}, "Not authenticated"],
    ["a non-member caller", fay, {}, "You are not a member of this group"],
    ["a non-member payer", dan, { paidBy: fay }, "Expense payer must be a group member"],
    ["a zero amount", dan, { amount: 0 }, "Expense amount must be greater than zero"],
    ["a zero exchange rate", dan, { rate: 0 }, "Exchange rate must be greater than zero"],
    ["a blank description", dan, { description: "   " }, "Expense description is required"],
    ["a negative split", dan, { splits: [{ userId: dan, amount: -5 }, { userId: erin, amount: 35 }] }, "Split amount cannot be negative"],
    ["a non-member split user", dan, { splits: half(dan, fay) }, "Every split user must be a group member"],
    ["no splits", dan, { splits: [] }, "At least one split is required"],
    ["splits not adding up", dan, { splits: half(dan, erin, 10) }, "Split amounts must add up to the expense total"],
    ["base amounts not adding up", dan, { rate: 2 }, "Split base amounts must add up to the converted total"],
  ];
  for (const [label, uid, overrides, expected] of groupErrors) {
    const got = await message(() => groupRpc(uid, overrides));
    check(got === expected, `create_expense_with_splits rejects ${label} with "${expected}" (got: ${got})`);
  }

  const gRow = await groupRpc(erin, {
    paidBy: erin, amount: 30, description: "  Dinner  ", category: "food", currency: " eur ",
    rate: 1.1, date: "2027-01-01T00:00:00Z",
    splits: [{ userId: dan, amount: 10, baseAmount: 11 }, { userId: erin, amount: 20, baseAmount: 22 }],
  });
  check(
    gRow.group_id === groupId && gRow.paid_by === erin && Number(gRow.amount) === 30 &&
      gRow.description === "Dinner" && gRow.category === "food" && gRow.split_type === "equal" &&
      gRow.currency === "EUR" && Number(gRow.exchange_rate) === 1.1 && Number(gRow.base_amount) === 33 &&
      new Date(gRow.date).toISOString() === "2027-01-01T00:00:00.000Z",
    "create_expense_with_splits stores the trimmed, converted row and honours p_date"
  );
  check(
    gRow.schedule_id === null && gRow.occurrence_date === null && gRow.hand_edited === false,
    "a created group expense has no schedule link and is not hand_edited"
  );
  const { rows: expenseCols } = await db.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'expenses'`
  );
  check(
    Object.keys(gRow).sort().join() === expenseCols.map((r) => r.column_name).sort().join(),
    "create_expense_with_splits returns a full expenses row"
  );
  const { rows: gSplits } = await db.query(
    `select user_id, amount, base_amount from public.expense_splits where expense_id = $1 order by amount`,
    [gRow.id]
  );
  check(
    gSplits.length === 2 && Number(gSplits[0].amount) === 10 && Number(gSplits[0].base_amount) === 11 &&
      Number(gSplits[1].amount) === 20 && Number(gSplits[1].base_amount) === 22,
    "create_expense_with_splits stores each split with its base amount"
  );
  const defaulted = await groupRpc(dan);
  check(
    Math.abs(Date.now() - new Date(defaulted.date).getTime()) < 60000 && defaulted.currency === "USD",
    "create_expense_with_splits dates a null p_date at now()"
  );

  // ---- Contact RPC ----------------------------------------------------------
  const contactRpc = (uid, o = {}) => {
    const a = {
      contact: ivy, paidBy: hal, amount: 30, description: "Taxi", category: null,
      splits: half(hal, ivy), date: null, currency: "USD", rate: 1, ...o,
    };
    return run(uid, async () => {
      const { rows } = await db.query(
        `select * from public.create_contact_expense_with_splits($1, $2, $3, $4, $5, 'equal', $6::jsonb, $7, $8, $9)`,
        [a.contact, a.paidBy, a.amount, a.description, a.category, JSON.stringify(a.splits), a.date, a.currency, a.rate]
      );
      return rows[0];
    });
  };
  const contactErrors = [
    ["a missing user", null, {}, "Not authenticated"],
    ["no contact", hal, { contact: null }, "Invalid contact"],
    ["yourself as the contact", hal, { contact: hal }, "Invalid contact"],
    ["a non-contact", hal, { contact: fay }, "You can only add expenses with accepted contacts"],
    ["a payer outside the pair", hal, { paidBy: fay }, "Expense payer must be you or the contact"],
    ["a zero amount", hal, { amount: 0 }, "Expense amount must be greater than zero"],
    ["a zero exchange rate", hal, { rate: 0 }, "Exchange rate must be greater than zero"],
    ["a blank description", hal, { description: " " }, "Expense description is required"],
    ["a negative split", hal, { splits: [{ userId: hal, amount: -5 }, { userId: ivy, amount: 35 }] }, "Split amount cannot be negative"],
    ["a split user outside the pair", hal, { splits: half(hal, fay) }, "Every split user must be a participant"],
    ["no splits", hal, { splits: [] }, "At least one split is required"],
    ["splits not adding up", hal, { splits: half(hal, ivy, 10) }, "Split amounts must add up to the expense total"],
    ["base amounts not adding up", hal, { rate: 2 }, "Split base amounts must add up to the converted total"],
  ];
  for (const [label, uid, overrides, expected] of contactErrors) {
    const got = await message(() => contactRpc(uid, overrides));
    check(got === expected, `create_contact_expense_with_splits rejects ${label} with "${expected}" (got: ${got})`);
  }

  const cRow = await contactRpc(ivy, {
    contact: hal, paidBy: hal, description: " Taxi ", currency: "cad", rate: 0.5,
    date: "2027-01-02T00:00:00Z",
    splits: [{ userId: hal, amount: 10, baseAmount: 5 }, { userId: ivy, amount: 20, baseAmount: 10 }],
  });
  const [lo, hi] = hal < ivy ? [hal, ivy] : [ivy, hal];
  check(
    cRow.user_lo === lo && cRow.user_hi === hi && cRow.paid_by === hal && Number(cRow.amount) === 30 &&
      cRow.description === "Taxi" && cRow.currency === "CAD" && Number(cRow.base_amount) === 15 &&
      new Date(cRow.date).toISOString() === "2027-01-02T00:00:00.000Z" &&
      cRow.schedule_id === null && cRow.occurrence_date === null && cRow.hand_edited === false,
    "create_contact_expense_with_splits stores the ordered pair, converted row and honours p_date"
  );
  const { rows: contactCols } = await db.query(
    `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'contact_expenses'`
  );
  check(
    Object.keys(cRow).sort().join() === contactCols.map((r) => r.column_name).sort().join(),
    "create_contact_expense_with_splits returns a full contact_expenses row"
  );
  const { rows: cSplits } = await db.query(
    `select amount, base_amount from public.contact_expense_splits where expense_id = $1 order by amount`,
    [cRow.id]
  );
  check(
    cSplits.length === 2 && Number(cSplits[0].base_amount) === 5 && Number(cSplits[1].base_amount) === 10,
    "create_contact_expense_with_splits stores each split with its base amount"
  );

  // ---- Helpers called directly as the owner, with no JWT --------------------
  const groupHelper = (o = {}) => {
    const a = {
      actor: dan, group: groupId, paidBy: dan, amount: 30, description: "Rent", splits: half(dan, erin),
      scheduleId: null, occurrenceDate: null, ...o,
    };
    return db
      .query(
        `select * from public._insert_group_expense(
           p_actor => $1::uuid, p_group_id => $2::uuid, p_paid_by => $3::uuid, p_amount => $4::numeric,
           p_description => $5::text, p_category => null, p_split_type => 'equal', p_splits => $6::jsonb,
           p_schedule_id => $7::uuid, p_occurrence_date => $8::date)`,
        [a.actor, a.group, a.paidBy, a.amount, a.description, JSON.stringify(a.splits), a.scheduleId, a.occurrenceDate]
      )
      .then((r) => r.rows[0]);
  };

  const noJwt = await db.query(`select auth.uid() as uid`);
  check(noJwt.rows[0].uid === null, "the helper checks below run with no JWT (auth.uid() is null)");

  const byErin = await groupHelper({ actor: erin, paidBy: erin });
  check(
    byErin.group_id === groupId && byErin.paid_by === erin && byErin.description === "Rent",
    "_insert_group_expense creates the expense for the p_actor it is given, with no JWT"
  );
  check(
    (await message(() => groupHelper({ actor: fay }))) === "You are not a member of this group",
    "_insert_group_expense checks membership of p_actor, not of the payer"
  );
  check(
    await rejects(groupHelper({ actor: null })),
    "_insert_group_expense rejects a null p_actor"
  );
  check(
    (await message(() => groupHelper({ amount: 0 }))) === "Expense amount must be greater than zero",
    "_insert_group_expense keeps the amount validation"
  );
  await db.exec(`select set_config('request.jwt.claim.sub', '${fay}', false)`);
  const withForeignJwt = await message(() => groupHelper({ actor: dan }));
  await db.exec(`select set_config('request.jwt.claim.sub', '', false)`);
  check(
    withForeignJwt === "(no error)",
    "_insert_group_expense ignores auth.uid(): a stranger's JWT does not block a member actor"
  );

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
  const occ = await groupHelper({ scheduleId: gSched, occurrenceDate: "2027-02-01" });
  const { rows: occDate } = await db.query(
    `select occurrence_date::text as d from public.expenses where id = $1`,
    [occ.id]
  );
  check(
    occ.schedule_id === gSched && occDate[0].d === "2027-02-01",
    "_insert_group_expense stores p_schedule_id and p_occurrence_date"
  );
  check(
    (await code(() => groupHelper({ scheduleId: gSched, occurrenceDate: "2027-02-01" }))) === "23505",
    "the same schedule and occurrence date a second time is rejected by the unique index"
  );
  check(
    (await message(() => groupHelper({ scheduleId: gSched, occurrenceDate: "2027-03-01" }))) === "(no error)",
    "the same schedule on another occurrence date is accepted"
  );
  const { rows: occRows } = await db.query(
    `select count(*)::int as n from public.expenses where schedule_id = $1`,
    [gSched]
  );
  check(occRows[0].n === 2, "a rejected duplicate leaves no row and no half-written splits behind");
  const { rows: orphanSplits } = await db.query(
    `select count(*)::int as n from public.expense_splits s
     join public.expenses e on e.id = s.expense_id where e.schedule_id = $1`,
    [gSched]
  );
  check(orphanSplits[0].n === 4, "each accepted occurrence has its two splits");

  const contactHelper = (o = {}) => {
    const a = {
      actor: hal, contact: ivy, paidBy: hal, amount: 30, description: "Subscription", splits: half(hal, ivy),
      scheduleId: null, occurrenceDate: null, ...o,
    };
    return db
      .query(
        `select * from public._insert_contact_expense(
           p_actor => $1::uuid, p_contact_user_id => $2::uuid, p_paid_by => $3::uuid, p_amount => $4::numeric,
           p_description => $5::text, p_category => null, p_split_type => 'equal', p_splits => $6::jsonb,
           p_schedule_id => $7::uuid, p_occurrence_date => $8::date)`,
        [a.actor, a.contact, a.paidBy, a.amount, a.description, JSON.stringify(a.splits), a.scheduleId, a.occurrenceDate]
      )
      .then((r) => r.rows[0]);
  };
  const byIvy = await contactHelper({ actor: ivy, contact: hal, paidBy: ivy });
  check(
    byIvy.paid_by === ivy && byIvy.user_lo === lo && byIvy.user_hi === hi,
    "_insert_contact_expense creates the expense for the p_actor it is given, with no JWT"
  );
  check(
    (await message(() => contactHelper({ actor: fay, contact: hal, paidBy: hal }))) ===
      "You can only add expenses with accepted contacts",
    "_insert_contact_expense checks the contact link of p_actor"
  );
  check(
    (await message(() => contactHelper({ actor: hal, contact: hal }))) === "Invalid contact",
    "_insert_contact_expense keeps the self-contact validation against p_actor"
  );
  const cSched = await insertSchedule({
    kind: "contact", user_lo: lo, user_hi: hi, created_by: hal, paid_by: hal,
    splits: JSON.stringify([{ userId: hal, amount: 30, baseAmount: 30 }]),
  });
  const cOcc = await contactHelper({ scheduleId: cSched, occurrenceDate: "2027-02-01" });
  const { rows: cOccDate } = await db.query(
    `select occurrence_date::text as d from public.contact_expenses where id = $1`,
    [cOcc.id]
  );
  check(
    cOcc.schedule_id === cSched && cOccDate[0].d === "2027-02-01",
    "_insert_contact_expense stores p_schedule_id and p_occurrence_date"
  );
  check(
    (await code(() => contactHelper({ scheduleId: cSched, occurrenceDate: "2027-02-01" }))) === "23505",
    "the same contact schedule and occurrence date a second time is rejected by the unique index"
  );
  check(
    (await message(() => contactHelper({ scheduleId: cSched, occurrenceDate: "2027-03-01" }))) === "(no error)",
    "the same contact schedule on another occurrence date is accepted"
  );
}
