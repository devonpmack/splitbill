// create_recurring_schedule and stop_recurring_schedule, plus the recurring
// clauses of leave_group and of the two currency guards. Everything runs
// through the public RPCs as signed-in users. Dates are offsets from the
// database's own UTC today (schedules use tz 'UTC'), so nothing depends on when
// the check runs.

const LEAVE_MSG = "You have upcoming or repeating transactions in this group. Cancel or stop them before leaving.";
const GROUP_CURRENCY_MSG = "Cannot change group currency while a repeating expense is active. Stop it first.";
const CONTACT_CURRENCY_MSG = "Cannot change contact currency while a repeating expense is active. Stop it first.";

export default async function recurringRpcs({ db, asUser, signUp, check }) {
  const amy = await signUp("rr-amy@example.com", "Amy");
  const ben = await signUp("rr-ben@example.com", "Ben");
  const cat = await signUp("rr-cat@example.com", "Cat");
  const dee = await signUp("rr-dee@example.com", "Dee");
  const eli = await signUp("rr-eli@example.com", "Eli");
  const flo = await signUp("rr-flo@example.com", "Flo");

  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const errorOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.message;
    }
  };
  const day = async (n) =>
    (await q(`select to_char((now() at time zone 'UTC')::date + $1::int, 'YYYY-MM-DD') as d`, [n]))[0].d;
  const yearAhead = async (extra) =>
    (await q(
      `select to_char(((now() at time zone 'UTC')::date + interval '1 year')::date + $1::int, 'YYYY-MM-DD') as d`,
      [extra]
    ))[0].d;
  const asAnon = async (fn) => {
    await db.exec(`set role anon; select set_config('request.jwt.claim.sub', '', false)`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role`);
    }
  };

  const makeGroup = (owner, name, emails, currency = "USD") =>
    asUser(owner, async () => (await q(
      `select * from public.create_group_with_members($1, $2::text[], $3)`, [name, emails, currency]
    ))[0].id);
  const befriend = async (a, aEmail, b, bEmail) => {
    await asUser(a, () => db.query(`select public.send_contact_request($1)`, [bEmail]));
    const [req] = await q(
      `select id from public.contact_requests where requester_id = $1 and status = 'pending' order by created_at desc limit 1`,
      [a]
    );
    await asUser(b, () => db.query(`select public.respond_contact_request($1, true)`, [req.id]));
  };

  const groupId = await makeGroup(amy, "Recurring RPCs", ["rr-ben@example.com", "rr-cat@example.com"]);
  const otherGroupId = await makeGroup(amy, "Elsewhere", ["rr-ben@example.com"]);
  await befriend(amy, "rr-amy@example.com", eli, "rr-eli@example.com");
  const [pairLo, pairHi] = amy < eli ? [amy, eli] : [eli, amy];

  const half = (a, b, amount = 15) => [
    { userId: a, amount },
    { userId: b, amount },
  ];
  const create = (uid, over = {}) => {
    const a = {
      group: groupId, contact: null, paidBy: amy, amount: 30, description: "Rent", category: "housing",
      splitType: "equal", splits: half(amy, ben), currency: "USD", rate: 1, start: null, tz: "UTC",
      frequency: "monthly", end: null, max: null, ...over,
    };
    const params = [
      a.group, a.contact, a.paidBy, a.amount, a.description, a.category, a.splitType,
      typeof a.splits === "string" ? a.splits : JSON.stringify(a.splits),
      a.currency, a.rate, a.start, a.tz, a.frequency, a.end, a.max,
    ];
    const run = async () =>
      (await q(
        `select * from public.create_recurring_schedule($1, $2, $3, $4, $5, $6, $7::public.split_type, $8::jsonb,
           $9, $10, $11::date, $12, $13, $14::date, $15::int)`,
        params
      ))[0];
    return uid === null ? run() : asUser(uid, run);
  };
  const createContact = (uid, over = {}) => {
    const other = uid === amy ? eli : amy;
    return create(uid, {
      group: null, contact: other, paidBy: other, amount: 20, splits: half(amy, eli, 10), ...over,
    });
  };
  const stop = (uid, id) => asUser(uid, async () => (await q(`select * from public.stop_recurring_schedule($1)`, [id]))[0]);

  const expensesOf = (id) =>
    q(
      `select id, to_char(occurrence_date, 'YYYY-MM-DD') as d, date > now() as future, hand_edited, paid_by,
         amount, base_amount
       from public.expenses where schedule_id = $1 order by occurrence_date`,
      [id]
    );
  const contactExpensesOf = (id) =>
    q(
      `select id, to_char(occurrence_date, 'YYYY-MM-DD') as d, date > now() as future, paid_by, amount
       from public.contact_expenses where schedule_id = $1 order by occurrence_date`,
      [id]
    );
  const count = async (table) => (await q(`select count(*)::int as n from public.${table}`))[0].n;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- The functions exist once each and are signed-in only ---------------------
  const { rows: fns } = await db.query(`
    select p.proname, count(*)::int as n, bool_and(p.prosecdef) as secdef,
      bool_and(coalesce(p.proconfig::text, '') like '%search_path=public, pg_temp%') as pinned,
      bool_or(p.prosrc ~* 'for update') as locks
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('create_recurring_schedule', 'stop_recurring_schedule')
    group by 1 order by 1
  `);
  check(
    fns.length === 2 && fns.every((r) => r.n === 1 && r.secdef && r.pinned),
    "create_recurring_schedule and stop_recurring_schedule exist once each, SECURITY DEFINER, search_path pinned"
  );
  check(
    fns.find((r) => r.proname === "stop_recurring_schedule")?.locks === true,
    "stop_recurring_schedule locks the schedule row (for update) so it serialises with the engine"
  );

  // ---- Create: group, nothing materialised for a future start ---------------------
  const farStart = await day(10);
  const expensesBefore = await count("expenses");
  const future = await create(amy, { start: farStart, description: "  Far rent  " });
  check(
    future.kind === "group" && future.group_id === groupId && future.user_lo === null && future.user_hi === null &&
      future.created_by === amy && future.paid_by === amy && future.description === "Far rent" &&
      Number(future.amount) === 30 && future.currency === "USD" && Number(future.last_exchange_rate) === 1 &&
      future.frequency === "monthly" && future.tz === "UTC" && future.next_index === 0 &&
      future.stopped_at === null && future.end_date === null && future.max_count === null,
    "create returns the stored group schedule (creator, payer, trimmed description, rate 1, cursor 0, active)"
  );
  check(
    (await count("expenses")) === expensesBefore && (await expensesOf(future.id)).length === 0,
    "a schedule that starts in 10 days creates no expense yet"
  );
  check(
    future.splits.length === 2 && future.splits[0].userId === amy && Number(future.splits[0].amount) === 15 &&
      future.splits[1].userId === ben,
    "the splits payload is stored as sent"
  );

  // ---- Create: only [{userId, amount}] is stored, normalised -------------------------
  const junk = await create(amy, {
    start: farStart, description: "Junk keys",
    splits: [
      { userId: amy.toUpperCase(), amount: "15.004", baseAmount: 999, junk: "x".repeat(200000), nested: { a: [1, 2] } },
      { userId: ben, amount: 14.996, note: "hi" },
    ],
  });
  check(
    junk.splits.length === 2 && junk.splits.every((e) => same(Object.keys(e).sort(), ["amount", "userId"])),
    "stored splits contain only userId and amount: baseAmount and every other key (a 200 KB one included) is dropped"
  );
  check(
    junk.splits[0].userId === amy && junk.splits[1].userId === ben &&
      Number(junk.splits[0].amount) === 15 && Number(junk.splits[1].amount) === 15,
    "stored splits hold the lowercase uuid text from the cast and amounts rounded to 2 places"
  );
  check(
    (await q(`select pg_column_size(splits) as n from public.recurring_schedules where id = $1`, [junk.id]))[0].n < 500,
    "the stored splits column stays small however much junk was sent"
  );

  // ---- Create: starting today materialises the first occurrence at once -----------
  const today = await day(0);
  const todays = await create(amy, { start: today, description: "Today rent" });
  const todaysRows = await expensesOf(todays.id);
  check(
    todays.next_index === 1 && same(todaysRows.map((r) => r.d), [today]) && todaysRows[0].future === false &&
      todaysRows[0].paid_by === amy && Number(todaysRows[0].amount) === 30,
    "a schedule starting today creates its first occurrence immediately and the returned row shows the moved cursor"
  );
  const todaySplits = await q(`select user_id, amount from public.expense_splits where expense_id = $1 order by user_id`, [todaysRows[0].id]);
  check(
    todaySplits.length === 2 && todaySplits.every((s) => Number(s.amount) === 15),
    "the first occurrence carries both splits"
  );

  // ---- Create: catches up past occurrences, up to 48 hours ahead -------------------
  const daily = await create(amy, { start: await day(-3), frequency: "daily", description: "Daily catch-up" });
  const dailyRows = await expensesOf(daily.id);
  const expectedDays = [await day(-3), await day(-2), await day(-1), await day(0), await day(1), await day(2)];
  check(
    same(dailyRows.map((r) => r.d), expectedDays) && daily.next_index === 6,
    "a daily schedule started 3 days ago catches up: 3 past dates, today and the next 2 days (the 48 hour horizon)"
  );
  check(
    dailyRows.filter((r) => r.future).length === 2,
    "the two occurrences ahead of now are future-dated rows (excluded from balances until their instant)"
  );

  // ---- Create: both limits are allowed, the first one reached wins -----------------
  const byCount = await create(amy, { start: await day(-3), frequency: "daily", max: 2, end: await day(100), description: "Count first" });
  check(
    (await expensesOf(byCount.id)).length === 2 && byCount.stopped_at !== null && byCount.stop_reason === "completed" &&
      byCount.next_index === 2,
    "with max_count 2 and a far end date the series stops after 2 occurrences"
  );
  const byEnd = await create(amy, { start: await day(-3), frequency: "daily", max: 10, end: await day(-1), description: "End first" });
  check(
    same((await expensesOf(byEnd.id)).map((r) => r.d), [await day(-3), await day(-2), await day(-1)]) &&
      byEnd.stop_reason === "completed",
    "with a near end date and a large max_count the end date wins"
  );

  // ---- Create: foreign currency converts each split through the engine's rounding ---
  const eur = await create(amy, {
    start: today, currency: "EUR", rate: 1.5, amount: 10, description: "Euro rent",
    splits: [{ userId: amy, amount: 3.33 }, { userId: ben, amount: 3.33 }, { userId: cat, amount: 3.34 }],
  });
  const eurRows = await expensesOf(eur.id);
  const eurSum = (await q(
    `select sum(base_amount) as s from public.expense_splits where expense_id = $1`, [eurRows[0].id]
  ))[0].s;
  check(
    Number(eur.last_exchange_rate) === 1.5 && Number(eurRows[0].base_amount) === 15 && Number(eurSum) === 15,
    "a foreign-currency schedule stores the rate; its first occurrence converts and the split base amounts (5.00, 5.00, 5.01 less the 0.01 remainder) add up to 15.00"
  );

  // ---- Create: contact schedules ----------------------------------------------------
  const contactSched = await createContact(amy, { start: today, frequency: "weekly", description: "Phone plan" });
  const contactRows = await contactExpensesOf(contactSched.id);
  check(
    contactSched.kind === "contact" && contactSched.group_id === null && contactSched.user_lo === pairLo &&
      contactSched.user_hi === pairHi && contactSched.paid_by === eli && contactSched.created_by === amy &&
      contactSched.next_index === 1,
    "p_contact_id is the other person: the pair is derived as (least, greatest) of caller and contact"
  );
  check(
    contactRows.length === 1 && contactRows[0].d === today && contactRows[0].paid_by === eli,
    "a contact schedule starting today creates its first contact expense"
  );
  const fromOther = await createContact(eli, { start: farStart, description: "Other side" });
  check(
    fromOther.user_lo === pairLo && fromOther.user_hi === pairHi && fromOther.created_by === eli,
    "the other participant creating a contact schedule derives the same pair"
  );

  // ---- Create: validation, each with its message ------------------------------------
  const refuses = async (label, expected, uid, over) => {
    const schedulesBefore = await count("recurring_schedules");
    const expensesBefore2 = await count("expenses") + (await count("contact_expenses"));
    const got = await errorOf(create(uid, { start: farStart, ...over }));
    check(
      got === expected &&
        (await count("recurring_schedules")) === schedulesBefore &&
        (await count("expenses")) + (await count("contact_expenses")) === expensesBefore2,
      `create_recurring_schedule refuses ${label} with "${expected}"${got === expected ? "" : ` (got: ${got})`} and creates nothing`
    );
  };
  await refuses("a group and a contact together", "Choose either a group or a contact for a repeating expense", amy, { contact: eli });
  await refuses("neither a group nor a contact", "Choose either a group or a contact for a repeating expense", amy, { group: null });
  await refuses("a non-member", "You are not a member of this group", dee, {});
  await refuses("a contact that is not accepted", "You can only add expenses with accepted contacts", amy, { group: null, contact: flo, paidBy: flo, splits: half(amy, flo) });
  await refuses("yourself as the contact", "Invalid contact", amy, { group: null, contact: amy, paidBy: amy });
  await refuses("a payer outside the group (forged payer)", "Expense payer must be a group member", amy, { paidBy: dee });
  await refuses("a missing payer", "Expense payer is required", amy, { paidBy: null });
  await refuses("a third party as contact payer", "Expense payer must be you or the contact", amy, { group: null, contact: eli, paidBy: ben, splits: half(amy, eli) });
  await refuses("a zero amount", "Expense amount must be greater than zero", amy, { amount: 0, splits: half(amy, ben, 0) });
  await refuses("a missing amount", "Expense amount must be greater than zero", amy, { amount: null });
  await refuses("a blank description", "Expense description is required", amy, { description: "   " });
  await refuses("splits that are not a list", "Splits must be a list", amy, { splits: "{}" });
  await refuses("no splits", "At least one split is required", amy, { splits: [] });
  await refuses("a split without an amount", "Each split needs a user and an amount", amy, { splits: [{ userId: amy }, { userId: ben, amount: 30 }] });
  await refuses("a split user that is not a uuid", "Each split needs a user and an amount", amy, { splits: [{ userId: "nobody", amount: 30 }] });
  await refuses("a split user outside the group", "Every split user must be a group member", amy, { splits: [{ userId: amy, amount: 15 }, { userId: dee, amount: 15 }] });
  await refuses("splits that do not add up", "Split amounts must add up to the expense total", amy, { splits: half(amy, ben, 10) });
  await refuses("a negative split", "Split amount cannot be negative", amy, { splits: [{ userId: amy, amount: 40 }, { userId: ben, amount: -10 }] });
  await refuses("a NaN amount", "Expense amount must be greater than zero", amy, { amount: "NaN" });
  await refuses("an infinite amount", "Expense amount must be greater than zero", amy, { amount: "Infinity" });
  await refuses("a NaN exchange rate", "Exchange rate must be greater than zero", amy, { rate: "NaN" });
  await refuses("an infinite exchange rate", "Exchange rate must be greater than zero", amy, { rate: "Infinity" });
  await refuses("a NaN split amount", "Each split needs a user and an amount", amy, { splits: [{ userId: amy, amount: "NaN" }, { userId: ben, amount: 30 }] });
  await refuses("an infinite split amount", "Each split needs a user and an amount", amy, { splits: [{ userId: amy, amount: "Infinity" }, { userId: ben, amount: 30 }] });
  await refuses("a missing split type", "Split type is required", amy, { splitType: null });
  await refuses("an exchange rate of zero", "Exchange rate must be greater than zero", amy, { rate: 0 });
  await refuses("an unknown frequency", "Frequency must be daily, weekly, biweekly, monthly or yearly", amy, { frequency: "hourly" });
  await refuses("an unknown time zone", "Time zone is not valid", amy, { tz: "Mars/Olympus" });
  await refuses("a missing time zone", "Time zone is not valid", amy, { tz: null });
  await refuses("a missing start date", "Start date is required", amy, { start: null });
  await refuses("an end date before the start", "End date cannot be before the start date", amy, { end: await day(9) });
  await refuses("a max_count of zero", "Number of repeats must be greater than zero", amy, { max: 0 });
  await refuses("a start more than 31 days back", "Start date cannot be more than 31 days in the past", amy, { start: await day(-32) });
  await refuses("a start more than a year ahead", "Start date cannot be more than a year ahead", amy, { start: await yearAhead(1) });

  const edgePast = await create(amy, { start: await day(-31), description: "Oldest allowed" });
  const edgeFuture = await create(amy, { start: await yearAhead(0), description: "Furthest allowed" });
  check(
    edgePast.id && edgeFuture.id && edgeFuture.next_index === 0,
    "a start 31 days back and a start exactly a year ahead are both accepted"
  );
  const toronto = await create(amy, { start: farStart, tz: "America/Toronto", description: "Toronto" });
  check(toronto.tz === "America/Toronto", "an IANA zone name is accepted and stored");

  // ---- Create: authorization and the signed-in-only rule -----------------------------
  check(
    (await errorOf(asAnon(() => create(null, { start: farStart })))) === "Not authenticated",
    "anon cannot create a schedule (Not authenticated)"
  );
  check(
    (await errorOf(create(null, { start: farStart }))) === "Not authenticated",
    "a call without a user id cannot create a schedule"
  );

  // ---- Create is atomic: a failure while materialising leaves nothing behind ------------
  await db.exec(`
    create function public._rr_boom() returns trigger language plpgsql as
      $$ begin raise exception 'boom from trigger'; end $$;
    create trigger rr_boom before insert on public.expenses
      for each row when (new.schedule_id is not null and new.description = 'boom')
      execute function public._rr_boom();
  `);
  const beforeBoom = await count("recurring_schedules");
  const boomMessage = await errorOf(create(amy, { start: today, description: "boom" }));
  await db.exec(`drop trigger rr_boom on public.expenses; drop function public._rr_boom()`);
  check(
    boomMessage === "boom from trigger" && (await count("recurring_schedules")) === beforeBoom &&
      (await q(`select 1 from public.recurring_schedules where description = 'boom'`)).length === 0 &&
      (await q(`select 1 from public.expenses where description = 'boom'`)).length === 0,
    "a schedule whose first occurrence fails to insert fails the whole create with the real error and leaves no schedule row"
  );

  // ---- RLS: members see the row, others do not -----------------------------------
  const seen = (uid, id) =>
    asUser(uid, async () => (await q(`select group_id, kind from public.recurring_schedules where id = $1`, [id])).length);
  check(
    (await seen(amy, future.id)) === 1 && (await seen(ben, future.id)) === 1 && (await seen(cat, future.id)) === 1 &&
      (await seen(dee, future.id)) === 0 && (await seen(eli, future.id)) === 0,
    "every group member reads the new group schedule under RLS and a stranger does not"
  );
  check(
    (await seen(amy, contactSched.id)) === 1 && (await seen(eli, contactSched.id)) === 1 &&
      (await seen(ben, contactSched.id)) === 0 && (await seen(dee, contactSched.id)) === 0,
    "the two contact participants read the new contact schedule and nobody else does"
  );
  const visibleToBen = (await asUser(ben, () =>
    q(`select count(*)::int as n from public.recurring_schedules where group_id = $1`, [groupId])
  ))[0].n;
  const allInGroup = (await q(`select count(*)::int as n from public.recurring_schedules where group_id = $1`, [groupId]))[0].n;
  check(
    visibleToBen === allInGroup && allInGroup > 0,
    "a member sees every schedule of the group, and only that group's"
  );

  // ---- Stop: deletes pending future rows, keeps past and hand-edited ones -------------
  const toStop = await create(amy, { start: await day(-1), frequency: "daily", description: "Stop me" });
  const beforeStop = await expensesOf(toStop.id);
  check(
    same(beforeStop.map((r) => [r.d, r.future]), [[await day(-1), false], [await day(0), false], [await day(1), true], [await day(2), true]]),
    "stop fixture: two past rows and two future rows"
  );
  const futureIds = beforeStop.filter((r) => r.future).map((r) => r.id);
  await asUser(ben, () => db.query(
    `select * from public.update_expense_with_splits($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [futureIds[0], amy, 30, "Stop me (edited)", "housing", "equal", JSON.stringify(half(amy, ben))]
  ));
  check(
    (await q(`select hand_edited from public.expenses where id = $1`, [futureIds[0]]))[0].hand_edited === true,
    "stop fixture: a member's edit marks one future row hand_edited"
  );
  const stopped = await stop(cat, toStop.id);
  check(
    stopped.id === toStop.id && stopped.stopped_at !== null && stopped.stop_reason === "stopped" && stopped.next_index === 4,
    "any member can stop (here a split-less member): the returned row has stopped_at and stop_reason 'stopped'"
  );
  const afterStop = await expensesOf(toStop.id);
  check(
    same(afterStop.map((r) => r.d), [await day(-1), await day(0), await day(1)]) &&
      afterStop[2].hand_edited === true && afterStop[2].id === futureIds[0],
    "stop deleted the pending future row and kept the past rows and the hand-edited future row"
  );
  check(
    (await q(`select 1 from public.expense_splits where expense_id = $1`, [futureIds[1]])).length === 0 &&
      (await q(`select 1 from public.expense_splits where expense_id = $1`, [futureIds[0]])).length === 2,
    "the deleted occurrence's splits went with it and the kept one still has its splits"
  );
  const stoppedAt = (await q(`select stopped_at from public.recurring_schedules where id = $1`, [toStop.id]))[0].stopped_at;
  const again = await stop(amy, toStop.id);
  check(
    again.id === toStop.id && new Date(again.stopped_at).getTime() === new Date(stoppedAt).getTime() &&
      again.stop_reason === "stopped" && (await expensesOf(toStop.id)).length === 3,
    "stopping a stopped schedule is a no-op that returns the row (stopped_at unchanged)"
  );
  const engineOnStopped = (await q(`select public._materialise_one($1, now() + interval '30 days') as n`, [toStop.id]))[0].n;
  check(
    engineOnStopped === 0 && (await expensesOf(toStop.id)).length === 3,
    "the engine creates nothing for a stopped schedule"
  );
  check(
    (await expensesOf(daily.id)).length === 6 && (await expensesOf(todays.id)).length === 1,
    "stopping one schedule leaves other schedules' rows alone"
  );

  const contactFuture = await createContact(amy, { start: await day(-1), frequency: "daily", description: "Contact stop" });
  const cfRows = await contactExpensesOf(contactFuture.id);
  check(
    same(cfRows.map((r) => r.future), [false, false, true, true]),
    "contact stop fixture: two past rows and two future rows"
  );
  const cStopped = await stop(eli, contactFuture.id);
  check(
    cStopped.stopped_at !== null && cStopped.stop_reason === "stopped" &&
      same((await contactExpensesOf(contactFuture.id)).map((r) => r.future), [false, false]) &&
      (await q(
        `select 1 from public.contact_expense_splits where expense_id = any($1::uuid[])`,
        [cfRows.filter((r) => r.future).map((r) => r.id)]
      )).length === 0,
    "stopping a contact schedule deletes its future contact expenses (and their splits) and keeps the past ones"
  );

  // ---- Stop: authorization ---------------------------------------------------------------
  check(
    (await errorOf(stop(dee, future.id))) === "Schedule not found" &&
      (await q(`select stopped_at from public.recurring_schedules where id = $1`, [future.id]))[0].stopped_at === null,
    "a non-member cannot stop a group schedule, and gets the same 'Schedule not found' as for a missing id (no existence leak)"
  );
  check(
    (await errorOf(stop(ben, fromOther.id))) === "Schedule not found" &&
      (await q(`select stopped_at from public.recurring_schedules where id = $1`, [fromOther.id]))[0].stopped_at === null,
    "a non-participant cannot stop a contact schedule and gets 'Schedule not found' too"
  );
  check(
    (await errorOf(stop(amy, "00000000-0000-0000-0000-000000000000"))) === "Schedule not found",
    "stopping an unknown schedule says so"
  );
  check(
    (await errorOf(asAnon(() => q(`select * from public.stop_recurring_schedule($1)`, [future.id])))) === "Not authenticated",
    "anon cannot stop a schedule (Not authenticated)"
  );

  // ---- leave_group: BOTH clauses (future rows, active schedules) ---------------------------
  const isMember = async (uid, gid) =>
    (await q(`select 1 from public.group_members where group_id = $1 and user_id = $2`, [gid, uid])).length === 1;
  const leave = (uid, gid) => asUser(uid, () => errorOf(db.query(`select public.leave_group($1)`, [gid])));
  const lg = await makeGroup(amy, "Leave guards", ["rr-ben@example.com", "rr-cat@example.com", "rr-dee@example.com", "rr-eli@example.com"]);

  // Clause 1, with no schedule anywhere: a plain future-dated expense.
  const plain = await asUser(amy, async () => (await q(
    `select * from public.create_expense_with_splits($1, $2, 10, 'Concert', null, 'equal', $3::jsonb, $4::timestamptz)`,
    [lg, eli, JSON.stringify(half(eli, amy, 5)), new Date(Date.now() + 5 * 86400000).toISOString()]
  ))[0].id);
  check(
    (await leave(eli, lg)) === LEAVE_MSG && (await leave(amy, lg)) === LEAVE_MSG && (await isMember(eli, lg)),
    "leave_group clause 1: a future-dated expense (no schedule) still refuses its payer and split member"
  );
  await asUser(amy, () => db.query(`select public.delete_expense($1)`, [plain]));
  check(
    (await leave(eli, lg)) === null && !(await isMember(eli, lg)),
    "leave_group clause 1: once the future expense is deleted the member can leave"
  );

  // Clause 2, with no future rows: the schedule starts far ahead so nothing exists yet.
  const sched = await create(amy, {
    group: lg, paidBy: ben, splits: half(ben, cat), start: await day(20), description: "Guard series",
  });
  check(
    (await expensesOf(sched.id)).length === 0 &&
      (await q(`select 1 from public.expenses where group_id = $1 and date > now()`, [lg])).length === 0,
    "leave_group clause 2 fixture: an active schedule and no future rows at all"
  );
  check((await leave(ben, lg)) === LEAVE_MSG, "leave_group clause 2: the payer of an active schedule is refused");
  check((await leave(cat, lg)) === LEAVE_MSG, "leave_group clause 2: a split-only member of an active schedule is refused");
  check(
    (await leave(dee, lg)) === null && !(await isMember(dee, lg)),
    "leave_group clause 2: a member the schedule does not involve can leave"
  );
  check(await isMember(cat, lg), "the refused members are still in the group");

  const involvesCat = await create(amy, { group: lg, paidBy: amy, splits: half(amy, cat), start: await day(20), description: "Cat series" });
  const completed = await create(amy, {
    group: lg, paidBy: cat, splits: [{ userId: cat, amount: 30 }], start: await day(-2), frequency: "daily", max: 1,
    description: "Done series",
  });
  check(completed.stop_reason === "completed", "leave_group fixture: a completed schedule involving the split member");
  await stop(ben, sched.id);
  check(
    (await leave(ben, lg)) === null && !(await isMember(ben, lg)),
    "leave_group: after the schedule is stopped (by someone else) its payer can leave"
  );
  check((await leave(cat, lg)) === LEAVE_MSG, "leave_group: a second active schedule still blocks its split member");
  await stop(cat, involvesCat.id);
  check(
    (await leave(cat, lg)) === null && !(await isMember(cat, lg)),
    "leave_group: once every active schedule is stopped the split member can leave (a completed one does not block)"
  );

  // Uppercase userId: it casts to a uuid, so it must block exactly like the lowercase one.
  const lgU = await makeGroup(amy, "Leave uppercase", ["rr-ben@example.com", "rr-cat@example.com"]);
  await create(amy, {
    group: lgU, paidBy: amy, splits: [{ userId: cat.toUpperCase(), amount: 15 }, { userId: amy, amount: 15 }],
    start: await day(20), description: "Uppercase split",
  });
  check(
    (await leave(cat, lgU)) === LEAVE_MSG && (await isMember(cat, lgU)),
    "leave_group: a split user sent in UPPERCASE is still refused (create stores the normalised uuid)"
  );
  const lgU2 = await makeGroup(amy, "Leave raw uppercase", ["rr-ben@example.com"]);
  await db.query(
    `insert into public.recurring_schedules (kind, group_id, created_by, paid_by, description, amount, last_exchange_rate,
       splits, start_date, tz, frequency)
     values ('group', $1, $2, $2, 'Raw', 30, 1, $3::jsonb, (now() at time zone 'UTC')::date + 20, 'UTC', 'monthly')`,
    [lgU2, amy, JSON.stringify([{ userId: ben.toUpperCase(), amount: 30 }])]
  );
  check(
    (await leave(ben, lgU2)) === LEAVE_MSG,
    "leave_group compares split users as uuids: a stored UPPERCASE userId (not written by create) still blocks"
  );

  // created_by is audit only: a creator who neither pays nor is split can leave, the series goes on.
  const lgC = await makeGroup(amy, "Leave creator", ["rr-ben@example.com", "rr-cat@example.com"]);
  const creatorOnly = await create(amy, {
    group: lgC, paidBy: ben, splits: half(ben, cat), start: await day(20), description: "Creator only",
  });
  check(
    (await leave(amy, lgC)) === null && !(await isMember(amy, lgC)),
    "leave_group: the creator of an active schedule who is neither payer nor split user can leave"
  );
  check(
    (await q(`select stopped_at from public.recurring_schedules where id = $1`, [creatorOnly.id]))[0].stopped_at === null &&
      (await q(`select public._materialise_one($1, now() + interval '25 days') as n`, [creatorOnly.id]))[0].n === 1,
    "the series the departed creator made stays active and the engine still creates its occurrences"
  );
  const lgC2 = await makeGroup(amy, "Leave creator payer", ["rr-ben@example.com"]);
  await create(amy, { group: lgC2, paidBy: amy, splits: half(amy, ben), start: await day(20), description: "Creator pays" });
  check(
    (await leave(amy, lgC2)) === LEAVE_MSG,
    "leave_group: a creator who is also the payer is refused"
  );

  // A schedule in another group, or a contact schedule, does not block this one.
  const lg2 = await makeGroup(cat, "Leave elsewhere", ["rr-ben@example.com"]);
  check(
    (await leave(ben, lg2)) === null,
    "a member with no schedule in this group can leave it (schedules elsewhere do not count)"
  );

  // The last member leaves a group with an active schedule: the group goes, schedule too.
  const lg3 = await makeGroup(cat, "Leave last", []);
  const lastSched = await create(cat, { group: lg3, paidBy: cat, splits: [{ userId: cat, amount: 30 }], start: await day(20), description: "Solo" });
  check(
    (await leave(cat, lg3)) === null &&
      (await q(`select 1 from public.groups where id = $1`, [lg3])).length === 0 &&
      (await q(`select 1 from public.recurring_schedules where id = $1`, [lastSched.id])).length === 0,
    "the last member can still leave, deleting the group and its schedule, as in the future-dated rule"
  );

  // ---- Currency guards -------------------------------------------------------------------
  const cg = await makeGroup(amy, "Currency guard", ["rr-ben@example.com"]);
  const cgSched = await create(amy, { group: cg, splits: half(amy, ben), start: await day(20), description: "Currency series" });
  const setGroup = (uid, gid, cur) =>
    asUser(uid, () => errorOf(db.query(`select public.set_group_currency($1, $2)`, [gid, cur])));
  check(
    (await setGroup(amy, cg, "EUR")) === GROUP_CURRENCY_MSG &&
      (await q(`select currency from public.groups where id = $1`, [cg]))[0].currency === "USD",
    "set_group_currency refuses a change while an active schedule exists, even with no activity yet"
  );
  check(
    (await setGroup(amy, cg, "USD")) === null,
    "set_group_currency still accepts the group's current currency"
  );
  check(
    (await setGroup(amy, otherGroupId, "EUR")) === null &&
      (await q(`select currency from public.groups where id = $1`, [otherGroupId]))[0].currency === "EUR",
    "a schedule in one group does not block another group's currency"
  );
  await stop(ben, cgSched.id);
  check(
    (await setGroup(amy, cg, "EUR")) === null && (await q(`select currency from public.groups where id = $1`, [cg]))[0].currency === "EUR",
    "after the schedule is stopped the group currency can change"
  );

  const setContact = (uid, other, cur) =>
    asUser(uid, () => errorOf(db.query(`select public.set_contact_currency($1, $2)`, [other, cur])));
  await createContact(amy, { start: await day(20), description: "Contact currency series" });
  check(
    (await setContact(amy, eli, "EUR")) === CONTACT_CURRENCY_MSG && (await setContact(eli, amy, "EUR")) === CONTACT_CURRENCY_MSG,
    "set_contact_currency refuses a change for either participant while an active contact schedule exists"
  );

  // A pair with no activity of its own: only the schedule stands in the way.
  const gus = await signUp("rr-gus@example.com", "Gus");
  const hal = await signUp("rr-hal@example.com", "Hal");
  await befriend(gus, "rr-gus@example.com", hal, "rr-hal@example.com");
  const ccSched = await create(gus, {
    group: null, contact: hal, paidBy: hal, amount: 20, splits: half(gus, hal, 10), start: await day(20),
    description: "Pair currency series",
  });
  check(
    (await setContact(hal, gus, "EUR")) === CONTACT_CURRENCY_MSG &&
      (await q(`select currency from public.contact_pair_settings where user_lo = least($1::uuid, $2::uuid) and user_hi = greatest($1::uuid, $2::uuid)`, [gus, hal])).length === 0,
    "set_contact_currency refuses a change for a pair that has a schedule but no activity, and writes nothing"
  );
  check(
    (await setContact(gus, hal, "USD")) === null,
    "set_contact_currency still accepts the pair's current currency"
  );
  await stop(hal, ccSched.id);
  check(
    (await setContact(gus, hal, "EUR")) === null,
    "after the pair's schedule is stopped the contact currency can change"
  );
}
