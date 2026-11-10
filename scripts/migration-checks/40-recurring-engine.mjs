// The recurring engine: _materialise_one (one schedule, raises on any problem),
// _materialise_recurring (the cron / catch-up runner, one failure never blocks
// another schedule) and materialise_my_recurring (what a signed-in client calls
// on app open). Schedules are inserted as the owner; the create/stop RPCs come
// in later pieces. Horizons are passed explicitly so nothing depends on today.

export default async function recurringEngine({ db, asUser, signUp, rejects, check }) {
  const dan = await signUp("re-dan@example.com", "Dan");
  const erin = await signUp("re-erin@example.com", "Erin");
  const fay = await signUp("re-fay@example.com", "Fay");
  const gus = await signUp("re-gus@example.com", "Gus");
  const hal = await signUp("re-hal@example.com", "Hal");
  const ivy = await signUp("re-ivy@example.com", "Ivy");

  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const makeGroup = (name, emails, currency = "USD") =>
    asUser(dan, async () => {
      const { rows } = await db.query(
        `select * from public.create_group_with_members($1, $2::text[], $3)`,
        [name, emails, currency]
      );
      return rows[0].id;
    });
  const groupId = await makeGroup("Engine", ["re-erin@example.com", "re-fay@example.com"]);
  const otherGroupId = await makeGroup("Elsewhere", ["re-fay@example.com"]);

  await asUser(hal, () => db.query(`select public.send_contact_request('re-ivy@example.com')`));
  const [req] = await q(`select id from public.contact_requests where requester_id = $1`, [hal]);
  await asUser(ivy, () => db.query(`select public.respond_contact_request($1, true)`, [req.id]));
  const [lo, hi] = hal < ivy ? [hal, ivy] : [ivy, hal];

  const half = (a, b, amount = 15) => [
    { userId: a, amount, baseAmount: amount },
    { userId: b, amount, baseAmount: amount },
  ];
  const mk = async (fields = {}) => {
    const row = {
      kind: "group", group_id: groupId, created_by: dan, paid_by: dan, description: "Rent",
      amount: 30, currency: "USD", last_exchange_rate: 1, split_type: "equal",
      splits: JSON.stringify(half(dan, erin)), start_date: "2030-01-01", tz: "UTC",
      frequency: "monthly", ...fields,
    };
    const cols = Object.keys(row);
    const { rows } = await db.query(
      `insert into public.recurring_schedules (${cols.join(", ")})
       values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row)
    );
    return rows[0].id;
  };
  const mkContact = (fields = {}) =>
    mk({
      kind: "contact", group_id: null, user_lo: lo, user_hi: hi, created_by: hal, paid_by: ivy,
      amount: 20, splits: JSON.stringify(half(hal, ivy, 10)), ...fields,
    });

  const rowsOf = (id, table = "expenses") =>
    q(
      `select id, to_char(occurrence_date, 'YYYY-MM-DD') as d,
         to_char(date at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI') as at_utc, *
       from public.${table} where schedule_id = $1 order by occurrence_date`,
      [id]
    );
  const dates = async (id, table) => (await rowsOf(id, table)).map((r) => r.d);
  const sched = async (id) => (await q(`select * from public.recurring_schedules where id = $1`, [id]))[0];
  const one = async (id, horizon) =>
    (await q(`select public._materialise_one($1::uuid, $2::timestamptz) as n`, [id, horizon]))[0].n;
  const runner = async (horizon) =>
    (horizon
      ? await q(`select public._materialise_recurring($1::timestamptz) as n`, [horizon])
      : await q(`select public._materialise_recurring() as n`))[0].n;
  const quiesce = () =>
    db.query(`update public.recurring_schedules set stopped_at = now(), stop_reason = 'completed' where stopped_at is null`);
  const code = async (fn) => {
    try {
      await fn();
      return "(no error)";
    } catch (error) {
      return error.code;
    }
  };
  const days = (from, to) => {
    const out = [];
    for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
    return out;
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---- The cron migration is a no-op without pg_cron (PGlite has none) --------------
  const { readFileSync } = await import("node:fs");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const cronSql = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "migrations", "20261109195000_recurring_cron.sql"),
    "utf8"
  );
  const { rows: cronAvailable } = await db.query(`select 1 from pg_available_extensions where name = 'pg_cron'`);
  let cronError = "";
  try {
    await db.exec(cronSql);
    await db.exec(cronSql);
  } catch (error) {
    cronError = error.message;
  }
  const { rows: cronSchema } = await db.query(`select 1 from pg_namespace where nspname = 'cron'`);
  check(
    cronAvailable.length === 0 && cronError === "" && cronSchema.length === 0 &&
      /pg_available_extensions/.test(cronSql) && /_materialise_recurring\(\)/.test(cronSql),
    `the cron migration does nothing, twice over, where pg_cron is unavailable${cronError ? `: ${cronError}` : ""} (the job itself is not exercised here)`
  );

  // Where pg_cron is listed but cannot be created, the guard passes and the
  // create extension fails. Force the guard open (PGlite has no pg_cron, so the
  // create fails the same way) and the failure must be swallowed, not abort the migration.
  const forced = cronSql.replace(/if exists \(select 1 from pg_available_extensions[^)]*\) then/, "if true then");
  let forcedError = "";
  try {
    await db.exec(forced);
  } catch (error) {
    forcedError = error.message;
  }
  check(
    forced !== cronSql && forcedError === "" && !/sqlerrm/i.test(cronSql) && /raise notice 'pg_cron job not scheduled: %', sqlstate/.test(cronSql),
    `a failure while enabling or scheduling pg_cron is swallowed with a generic notice, not raised${forcedError ? `: ${forcedError}` : ""}`
  );

  // ---- The functions exist once each, pinned and private ----------------------
  const { rows: fns } = await db.query(`
    select p.proname, count(*)::int as n, bool_and(p.prosecdef) as secdef,
      bool_and(coalesce(p.proconfig::text, '') like '%search_path=public, pg_temp%') as pinned
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('_schedule_rate', '_occurrence_date',
      '_convert_splits_to_base', '_materialise_one', '_materialise_recurring', 'materialise_my_recurring')
    group by 1 order by 1
  `);
  check(
    fns.length === 6 && fns.every((r) => r.n === 1),
    `the engine functions exist exactly once each (${fns.map((r) => r.proname).join(", ")})`
  );
  check(
    fns.filter((r) => r.proname !== "_occurrence_date" && r.proname !== "_convert_splits_to_base" && r.proname !== "_schedule_rate")
      .every((r) => r.secdef) && fns.every((r) => r.pinned),
    "the engine functions pin search_path = public, pg_temp and the runners are SECURITY DEFINER"
  );
  const { rows: acl } = await db.query(`
    select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authed,
      coalesce(p.proacl::text, '') ~ '(^\\{|,)=X' as public_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('_schedule_rate', '_occurrence_date',
      '_convert_splits_to_base', '_materialise_one', '_materialise_recurring', 'materialise_my_recurring')
  `);
  check(
    acl.filter((r) => r.proname.startsWith("_")).every((r) => !r.anon && !r.authed && !r.public_exec),
    "the private engine functions are not executable by PUBLIC, anon or authenticated"
  );
  const wrapperAcl = acl.find((r) => r.proname === "materialise_my_recurring");
  check(
    wrapperAcl && wrapperAcl.authed && !wrapperAcl.anon && !wrapperAcl.public_exec,
    "materialise_my_recurring is executable by authenticated only (not anon, not PUBLIC)"
  );

  // ---- Occurrence dates: computed from the start date, never chained -----------
  const occ = async (start, frequency, n) =>
    (await q(`select to_char(public._occurrence_date($1::date, $2, $3), 'YYYY-MM-DD') as d`, [start, frequency, n]))[0].d;
  const seq = async (start, frequency, count) => {
    const out = [];
    for (let n = 0; n < count; n++) out.push(await occ(start, frequency, n));
    return out;
  };
  check(
    same(await seq("2030-01-31", "monthly", 5), ["2030-01-31", "2030-02-28", "2030-03-31", "2030-04-30", "2030-05-31"]),
    "monthly on the 31st clamps to the month end and returns to the 31st (no drift to the 28th)"
  );
  check(
    same(await seq("2028-01-31", "monthly", 3), ["2028-01-31", "2028-02-29", "2028-03-31"]),
    "monthly on the 31st lands on Feb 29 in a leap year"
  );
  check(
    same(await seq("2028-02-29", "yearly", 5), ["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]),
    "yearly on Feb 29 clamps to Feb 28 and returns to Feb 29 in the next leap year"
  );
  check(
    same(await seq("2030-01-30", "monthly", 2), ["2030-01-30", "2030-02-28"]) &&
      same(await seq("2030-12-31", "monthly", 3), ["2030-12-31", "2031-01-31", "2031-02-28"]),
    "monthly clamps across the year end too"
  );
  check(
    same(await seq("2030-02-26", "daily", 4), ["2030-02-26", "2030-02-27", "2030-02-28", "2030-03-01"]) &&
      same(await seq("2030-02-20", "weekly", 3), ["2030-02-20", "2030-02-27", "2030-03-06"]) &&
      same(await seq("2030-02-20", "biweekly", 3), ["2030-02-20", "2030-03-06", "2030-03-20"]),
    "daily, weekly and biweekly step by 1, 7 and 14 days"
  );

  // ---- Monthly on the 31st, idempotence and the cursor --------------------------
  const m31 = await mk({ start_date: "2030-01-31", description: "Rent 31st" });
  check((await one(m31, "2030-04-15T00:00:00Z")) === 3, "_materialise_one returns the number of expenses it created");
  const m31Rows = await rowsOf(m31);
  check(
    same(m31Rows.map((r) => r.d), ["2030-01-31", "2030-02-28", "2030-03-31"]) &&
      same(m31Rows.map((r) => r.at_utc), ["2030-01-31T00:00", "2030-02-28T00:00", "2030-03-31T00:00"]),
    "a monthly schedule on the 31st creates Jan 31, Feb 28 and Mar 31, each dated its own local midnight"
  );
  const m31Cursor = (await sched(m31)).next_index;
  check(m31Cursor === 3, "the cursor sits on the next occurrence to create (3)");
  const idsBefore = m31Rows.map((r) => r.id).join();
  check(
    (await one(m31, "2030-04-15T00:00:00Z")) === 0 &&
      (await rowsOf(m31)).map((r) => r.id).join() === idsBefore &&
      (await sched(m31)).next_index === 3,
    "running again changes nothing: same rows, same cursor, 0 created"
  );
  await db.query(`update public.recurring_schedules set next_index = 0 where id = $1`, [m31]);
  check(
    (await one(m31, "2030-04-15T00:00:00Z")) === 0 &&
      (await rowsOf(m31)).map((r) => r.id).join() === idsBefore &&
      (await sched(m31)).next_index === 3,
    "a lost cursor re-walks the dates: the unique index makes each a no-op and the cursor catches up"
  );
  check(
    (await one(m31, "2030-05-15T00:00:00Z")) === 1 && same(await dates(m31), ["2030-01-31", "2030-02-28", "2030-03-31", "2030-04-30"]),
    "a later horizon adds only the new occurrence"
  );

  // A unique violation that is not the schedule/occurrence index must not be read as "already made".
  const dup = await mk({ description: "Dup split", splits: JSON.stringify(half(dan, dan)), start_date: "2030-01-01" });
  check(
    (await code(() => one(dup, "2030-01-15T00:00:00Z"))) === "23505" &&
      (await rowsOf(dup)).length === 0 && (await sched(dup)).next_index === 0,
    "a duplicate split user raises its own unique violation instead of being skipped as already materialised"
  );

  // ---- Limits ---------------------------------------------------------------------
  const counted = await mk({ frequency: "daily", max_count: 3, description: "Three days" });
  check(
    (await one(counted, "2031-01-01T00:00:00Z")) === 3 && same(await dates(counted), ["2030-01-01", "2030-01-02", "2030-01-03"]),
    "max_count 3 creates three occurrences and no more"
  );
  const countedRow = await sched(counted);
  check(
    countedRow.next_index === 3 && countedRow.stopped_at !== null && countedRow.stop_reason === "completed",
    "reaching max_count stops the schedule with the generic reason 'completed'"
  );
  check((await one(counted, "2031-01-01T00:00:00Z")) === 0, "a stopped schedule makes nothing");

  const ended = await mk({ frequency: "weekly", end_date: "2030-01-22", description: "Until the 22nd" });
  check(
    (await one(ended, "2031-01-01T00:00:00Z")) === 4 && same(await dates(ended), ["2030-01-01", "2030-01-08", "2030-01-15", "2030-01-22"]),
    "end_date is inclusive and nothing is created after it"
  );
  const endedRow = await sched(ended);
  check(endedRow.stopped_at !== null && endedRow.stop_reason === "completed", "passing end_date stops the schedule as 'completed'");

  const endBefore = await mk({ end_date: "2029-12-31", description: "Ended before it began" });
  check(
    (await one(endBefore, "2031-01-01T00:00:00Z")) === 0 && (await sched(endBefore)).stop_reason === "completed",
    "a schedule whose end_date is before its first occurrence creates nothing and stops"
  );

  // ---- Steps --------------------------------------------------------------------
  const daily = await mk({ frequency: "daily", description: "Daily" });
  const weekly = await mk({ frequency: "weekly", description: "Weekly" });
  const biweekly = await mk({ frequency: "biweekly", description: "Biweekly" });
  const yearly = await mk({ frequency: "yearly", start_date: "2028-02-29", description: "Yearly" });
  const stepHorizon = "2030-01-29T00:00:00Z";
  await one(daily, stepHorizon);
  await one(weekly, stepHorizon);
  await one(biweekly, stepHorizon);
  await one(yearly, "2032-03-01T00:00:00Z");
  check(same(await dates(daily), days("2030-01-01", "2030-01-29")), "a daily schedule creates every day");
  check(same(await dates(weekly), ["2030-01-01", "2030-01-08", "2030-01-15", "2030-01-22", "2030-01-29"]), "a weekly schedule steps 7 days");
  check(same(await dates(biweekly), ["2030-01-01", "2030-01-15", "2030-01-29"]), "a biweekly schedule steps 14 days");
  check(
    same(await dates(yearly), ["2028-02-29", "2029-02-28", "2030-02-28", "2031-02-28", "2032-02-29"]),
    "a yearly Feb 29 schedule creates Feb 28 in common years and Feb 29 in leap years"
  );

  // ---- Horizon boundary ------------------------------------------------------------
  const edge = await mk({ start_date: "2030-03-01", description: "Edge" });
  check((await one(edge, "2030-02-28T23:59:59Z")) === 0 && (await rowsOf(edge)).length === 0, "an occurrence one second past the horizon is not created");
  check((await one(edge, "2030-03-01T00:00:00Z")) === 1, "an occurrence exactly at the horizon is created");

  await quiesce();
  const [{ today }] = await q(`select to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as today`);
  const plus = async (n) => (await q(`select to_char((now() at time zone 'UTC')::date + $1::int, 'YYYY-MM-DD') as d`, [n]))[0].d;
  const soon = await mk({ start_date: await plus(2), description: "47h ahead" });
  const later = await mk({ start_date: await plus(3), description: "49h ahead" });
  await runner();
  check(
    (await rowsOf(soon)).length === 1 && (await rowsOf(later)).length === 0,
    `with the default 48 hour horizon an occurrence under 48 h ahead is created and one over 48 h ahead is not (today ${today})`
  );
  const soonRow = (await rowsOf(soon))[0];
  check(
    soonRow && new Date(soonRow.date).getTime() > Date.now() && soonRow.schedule_id === soon,
    "the early row is future-dated, so it does not count until its instant"
  );
  await quiesce();

  // ---- Time zones ------------------------------------------------------------------
  const toronto = await mk({ frequency: "daily", start_date: "2030-03-09", tz: "America/Toronto", description: "DST start" });
  await one(toronto, "2030-03-12T00:00:00Z");
  const torontoRows = await rowsOf(toronto);
  check(
    same(torontoRows.map((r) => r.at_utc), ["2030-03-09T05:00", "2030-03-10T05:00", "2030-03-11T04:00"]),
    "in America/Toronto across the March DST change the local midnights are 05:00Z, 05:00Z then 04:00Z"
  );
  const fall = await mk({ frequency: "daily", start_date: "2030-11-02", tz: "America/Toronto", description: "DST end" });
  await one(fall, "2030-11-05T00:00:00Z");
  check(
    same((await rowsOf(fall)).map((r) => r.at_utc), ["2030-11-02T04:00", "2030-11-03T04:00", "2030-11-04T05:00"]),
    "in America/Toronto across the November DST change the local midnights are 04:00Z, 04:00Z then 05:00Z"
  );
  const early = await mk({ start_date: "2030-05-10", tz: "Pacific/Kiritimati", description: "UTC+14" });
  const late = await mk({ start_date: "2030-05-10", tz: "Pacific/Pago_Pago", description: "UTC-11" });
  await one(early, "2030-05-09T12:00:00Z");
  await one(late, "2030-05-09T12:00:00Z");
  check(
    (await rowsOf(early)).length === 1 && (await rowsOf(early))[0].at_utc === "2030-05-09T10:00" && (await rowsOf(late)).length === 0,
    "the same calendar date is due at different instants per time zone (UTC+14 is due, UTC-11 is not)"
  );
  await one(late, "2030-05-10T11:00:00Z");
  check((await rowsOf(late)).length === 1 && (await rowsOf(late))[0].at_utc === "2030-05-10T11:00", "and it becomes due at its own local midnight");

  // ---- Foreign currency: the port ---------------------------------------------------
  const roundHalfUp = (x) => Math.round(x * 100) / 100;
  const jsConvert = (parts, rate, baseTotal) => {
    const result = parts.map((amount) => ({ amount, baseAmount: roundHalfUp(amount * rate) }));
    const sum = result.reduce((acc, s) => acc + s.baseAmount, 0);
    const remainder = Math.round((baseTotal - sum) * 100) / 100;
    if (remainder === 0 || result.length === 0) return result;
    let target = 0;
    for (let i = 1; i < result.length; i++) if (result[i].baseAmount > result[target].baseAmount) target = i;
    result[target].baseAmount = Math.round((result[target].baseAmount + remainder) * 100) / 100;
    return result;
  };
  const sqlConvert = async (parts, rate, amount) => {
    const splits = parts.map((a, i) => ({ userId: [dan, erin, fay][i % 3], amount: a }));
    const { rows } = await db.query(
      `select public._convert_splits_to_base($1::jsonb, $2::numeric, round($3::numeric * $2::numeric, 2)) as r`,
      [JSON.stringify(splits), rate, amount]
    );
    return rows[0].r.map((s) => Number(s.baseAmount));
  };
  const clearOfTies = (nums, rate) => nums.every((a) => Math.abs((a * rate * 100) % 1 - 0.5) > 0.02);
  const fixtures = [
    [10, [3.34, 3.33, 3.33]],
    [1, [0.34, 0.33, 0.33]],
    [20, [6.67, 6.67, 6.66]],
    [100, [50, 30, 20]],
    [7.5, [2.5, 2.5, 2.5]],
    [12.34, [4.12, 4.11, 4.11]],
  ];
  const rates = [0.37, 0.55, 0.73, 0.77, 0.83, 0.91, 1.13, 1.27, 1.31, 1.43, 1.57, 0.0073, 148.37, 1.0833];
  let compared = 0;
  let remainderSeen = false;
  let mismatches = [];
  for (const [amount, parts] of fixtures) {
    for (const rate of rates) {
      if (!clearOfTies([amount, ...parts], rate)) continue;
      const expected = jsConvert(parts, rate, Math.round(amount * rate * 100) / 100).map((s) => s.baseAmount);
      const got = await sqlConvert(parts, rate, amount);
      compared += 1;
      if (parts.map((a) => roundHalfUp(a * rate)).reduce((x, y) => x + y, 0).toFixed(2) !== (Math.round(amount * rate * 100) / 100).toFixed(2)) remainderSeen = true;
      if (!same(expected, got)) mismatches.push(`${amount}/${parts}@${rate}: js ${expected} sql ${got}`);
    }
  }
  check(
    compared > 40 && remainderSeen && mismatches.length === 0,
    `_convert_splits_to_base matches the client's convertSplitsToBase on ${compared} tie-free fixtures including remainder cents${mismatches.length ? `: ${mismatches.slice(0, 2).join("; ")}` : ""}`
  );
  const pinned = await sqlConvert([3.34, 3.33, 3.33], 1.13, 10);
  check(same(pinned, [3.78, 3.76, 3.76]), "a remainder cent goes to the first largest split (3.34/3.33/3.33 at 1.13 -> 3.78, 3.76, 3.76)");

  const fx = await mk({
    currency: "EUR", last_exchange_rate: "1.13", amount: 10, description: "Converted", frequency: "monthly",
    splits: JSON.stringify([
      { userId: dan, amount: 3.34, baseAmount: 999 },
      { userId: erin, amount: 3.33, baseAmount: 999 },
      { userId: fay, amount: 3.33 },
    ]),
  });
  await one(fx, "2030-01-15T00:00:00Z");
  const [fxRow] = await rowsOf(fx);
  const fxSplits = await q(`select amount, base_amount from public.expense_splits where expense_id = $1 order by amount desc, base_amount`, [fxRow.id]);
  check(
    fxRow.currency === "EUR" && Number(fxRow.exchange_rate) === 1.13 && Number(fxRow.base_amount) === 11.3 &&
      same(fxSplits.map((s) => Number(s.base_amount)), [3.78, 3.76, 3.76]),
    "a foreign-currency occurrence converts at the schedule's rate and ignores any stored baseAmount"
  );
  check(
    Number(fxSplits.reduce((a, s) => a + Number(s.base_amount), 0).toFixed(2)) === Number(fxRow.base_amount),
    "the split base amounts add up to the expense's base amount"
  );
  check(Number((await sched(fx)).last_exchange_rate) === 1.13, "the schedule keeps the rate it converted at in last_exchange_rate");

  const krw = await mk({
    currency: "KRW", last_exchange_rate: "0.000731234567", amount: 10000000, description: "Won",
    splits: JSON.stringify([{ userId: dan, amount: 10000000 }]),
  });
  await one(krw, "2030-01-15T00:00:00Z");
  const [krwRow] = await rowsOf(krw);
  check(
    Number(krwRow.base_amount) === 7312.35,
    `the unrounded rate is used for the conversion (10,000,000 x 0.000731234567 = 7312.35, got ${krwRow.base_amount})`
  );

  const same_ = await mk({ currency: "usd", last_exchange_rate: "1.7", description: "Same currency" });
  await one(same_, "2030-01-15T00:00:00Z");
  const [sameRow] = await rowsOf(same_);
  check(
    Number(sameRow.exchange_rate) === 1 && Number(sameRow.base_amount) === 30,
    "a same-currency schedule always converts at rate 1, whatever last_exchange_rate holds"
  );
  check(
    (await q(`select public._schedule_rate(s) as r from public.recurring_schedules s where id = $1`, [fx]))[0].r !== null &&
      Number((await q(`select public._schedule_rate(s) as r from public.recurring_schedules s where id = $1`, [fx]))[0].r) === 1.13,
    "_schedule_rate returns last_exchange_rate when there is no exchange_rates row"
  );

  // ---- Contact schedules --------------------------------------------------------------
  const contact = await mkContact({ start_date: "2030-01-10", description: "Phone plan" });
  check((await one(contact, "2030-02-20T00:00:00Z")) === 2, "a contact schedule creates its occurrences");
  const contactRows = await rowsOf(contact, "contact_expenses");
  check(
    same(contactRows.map((r) => r.d), ["2030-01-10", "2030-02-10"]) &&
      contactRows.every((r) => r.user_lo === lo && r.user_hi === hi && r.paid_by === ivy && r.schedule_id === contact),
    "contact occurrences land in contact_expenses for the pair, paid by the schedule's payer"
  );
  check(
    (await q(`select count(*)::int as n from public.contact_expense_splits where expense_id = any($1::uuid[])`, [contactRows.map((r) => r.id)]))[0].n === 4,
    "each contact occurrence gets its splits"
  );
  const contactFx = await mkContact({ currency: "CAD", last_exchange_rate: "0.75", description: "Phone abroad", start_date: "2030-01-10" });
  await one(contactFx, "2030-01-20T00:00:00Z");
  const [contactFxRow] = await rowsOf(contactFx, "contact_expenses");
  check(Number(contactFxRow.base_amount) === 15 && contactFxRow.currency === "CAD", "a foreign-currency contact schedule converts at the pair's base currency too");
  check((await rowsOf(contact)).length === 0, "a contact schedule never writes a group expense");

  // ---- Actor is paid_by; group_id matches the schedule ---------------------------------
  const actor = await mk({
    created_by: gus, paid_by: erin, description: "Erin pays", splits: JSON.stringify(half(dan, erin)), start_date: "2030-01-01",
  });
  await one(actor, "2030-02-10T00:00:00Z");
  const actorRows = await rowsOf(actor);
  check(
    actorRows.length === 2 && actorRows.every((r) => r.paid_by === erin),
    "occurrences are paid by the schedule's paid_by even when the creator is an outsider (actor = paid_by, no JWT)"
  );
  await db.query(`update public.recurring_schedules set created_by = null where id = $1`, [actor]);

  // ---- Deleted and hand-edited pending rows ----------------------------------------------
  const skip = await mk({ start_date: "2030-01-15", description: "Skippable" });
  await one(skip, "2030-03-20T00:00:00Z");
  const skipRows = await rowsOf(skip);
  await db.query(`update public.expenses set hand_edited = true, description = 'Edited by hand', amount = 31 where id = $1`, [skipRows[1].id]);
  await db.query(`delete from public.expenses where id = $1`, [skipRows[2].id]);
  check(
    (await one(skip, "2030-03-20T00:00:00Z")) === 0 && same(await dates(skip), ["2030-01-15", "2030-02-15"]),
    "a deleted pending occurrence is a skip: the cursor has passed it and it is not re-created"
  );
  const [edited] = await q(`select description, amount, hand_edited from public.expenses where id = $1`, [skipRows[1].id]);
  check(edited.description === "Edited by hand" && Number(edited.amount) === 31 && edited.hand_edited === true, "a hand-edited pending row is left exactly as it is");
  check(
    (await one(skip, "2030-04-20T00:00:00Z")) === 1 && same(await dates(skip), ["2030-01-15", "2030-02-15", "2030-04-15"]),
    "later occurrences continue after the skip and the skipped date stays skipped"
  );

  // ---- Catch-up cap -------------------------------------------------------------------------
  await quiesce();
  const long = await mk({ frequency: "daily", start_date: "2028-01-01", description: "Long catch-up" });
  check((await runner("2029-03-01T00:00:00Z")) === 400 && (await sched(long)).next_index === 400, "one run creates at most 400 occurrences per schedule");
  check((await runner("2029-03-01T00:00:00Z")) === 26 && (await sched(long)).next_index === 426, "the next run carries on from the cursor");
  await quiesce();

  // ---- Runner: member left, one broken schedule, transient errors ---------------------------
  const leaveGroup = await makeGroup("Leaving", ["re-erin@example.com", "re-fay@example.com"]);
  const goneSplit = await mk({ group_id: leaveGroup, description: "Fay splits", splits: JSON.stringify(half(dan, fay)), start_date: "2030-01-01" });
  const goneActive = await mk({ group_id: leaveGroup, description: "Erin splits", splits: JSON.stringify(half(dan, erin)), start_date: "2030-01-01" });
  const gonePayer = await mk({ group_id: leaveGroup, paid_by: fay, description: "Fay pays", splits: JSON.stringify(half(dan, erin)), start_date: "2030-01-01" });
  await db.query(`delete from public.group_members where group_id = $1 and user_id = $2`, [leaveGroup, fay]);
  const contactGone = await mkContact({ description: "Pair ended", start_date: "2030-01-01" });
  await db.query(`delete from public.contacts where (owner_id = $1 and contact_user_id = $2) or (owner_id = $2 and contact_user_id = $1)`, [hal, ivy]);
  const ran = await runner("2030-02-10T00:00:00Z");
  const splitRow = await sched(goneSplit);
  const payerRow = await sched(gonePayer);
  const contactRow = await sched(contactGone);
  check(
    splitRow.stopped_at !== null && splitRow.stop_reason === "member left" && (await rowsOf(goneSplit)).length === 0,
    "a split user who left the group stops that schedule with the generic reason 'member left' and creates nothing"
  );
  check(
    payerRow.stopped_at !== null && payerRow.stop_reason === "member left" && (await rowsOf(gonePayer)).length === 0,
    "a payer who left stops the schedule too"
  );
  check(
    contactRow.stopped_at !== null && contactRow.stop_reason === "member left" && (await rowsOf(contactGone, "contact_expenses")).length === 0,
    "a contact pair that is no longer accepted stops its schedule"
  );
  check(
    (await sched(goneActive)).stopped_at === null && (await rowsOf(goneActive)).length === 2 && ran === 2,
    "other schedules, even in the same group, are unaffected (the run returned only what it created)"
  );
  check(
    splitRow.last_error !== null && !/member|group|participant|contact/i.test(splitRow.last_error) && splitRow.failed_runs === 0,
    "last_error is generic text, never the raw database message"
  );

  await db.query(
    `insert into public.contacts (owner_id, contact_user_id) values ($1, $2), ($2, $1)`,
    [hal, ivy]
  );
  await quiesce();
  const badTz =await mk({ tz: "Not/AZone", description: "Bad zone", start_date: "2030-01-01" });
  const badSum = await mk({ description: "Bad sum", splits: JSON.stringify(half(dan, erin, 10)), start_date: "2030-01-01" });
  const fine = await mk({ description: "Fine", start_date: "2030-01-01" });
  await runner("2030-01-20T00:00:00Z");
  const badTzRow = await sched(badTz);
  const badSumRow = await sched(badSum);
  check(
    badTzRow.stopped_at !== null && badTzRow.stop_reason === "invalid" && badSumRow.stopped_at !== null && badSumRow.stop_reason === "invalid",
    "deterministic validation errors (unknown time zone, splits not adding up) stop the schedule as 'invalid'"
  );
  check((await rowsOf(fine)).length === 1, "the broken schedules did not block the good one created after them");

  await quiesce();
  await db.exec(`
    create function public.re_test_fail_trg() returns trigger language plpgsql as $$
    begin
      raise exception using errcode = '40001', message = 'could not serialize access: raw detail';
    end $$;
    create trigger re_test_fail before insert on public.expenses for each row
      when (new.description = 'TRANSIENT' and new.occurrence_date = date '2030-01-03')
      execute function public.re_test_fail_trg();
  `);
  const flaky = await mk({ frequency: "daily", description: "TRANSIENT", start_date: "2030-01-01" });
  const steady = await mk({ frequency: "daily", description: "Steady", start_date: "2030-01-01" });
  const transientRan = await runner("2030-01-05T00:00:00Z");
  const flakyRow = await sched(flaky);
  check(
    flakyRow.stopped_at === null && flakyRow.next_index === 0 && (await rowsOf(flaky)).length === 0 &&
      flakyRow.failed_runs === 1 && flakyRow.last_error !== null && !/serialize|raw detail/i.test(flakyRow.last_error),
    "a transient error leaves the schedule active, rolls back that run's progress, counts failed_runs and stores a generic last_error"
  );
  check(
    (await rowsOf(steady)).length === 5 && transientRan === 5,
    "a transient failure does not block the schedule after it (5 created)"
  );
  await runner("2030-01-05T00:00:00Z");
  check((await sched(flaky)).failed_runs === 2, "failed_runs keeps counting while it keeps failing");
  await db.exec(`drop trigger re_test_fail on public.expenses; drop function public.re_test_fail_trg();`);
  await runner("2030-01-05T00:00:00Z");
  const healed = await sched(flaky);
  check(
    (await rowsOf(flaky)).length === 5 && healed.failed_runs === 0 && healed.last_error === null && healed.next_index === 5,
    "the next run retries, catches up and clears failed_runs and last_error"
  );

  // ---- Wrapper vs runner: one code path, idempotent ----------------------------------------
  await quiesce();
  const startedAgo = await plus(-3);
  const trio = async (label) => [
    await mk({ frequency: "daily", start_date: startedAgo, description: `${label} A` }),
    await mk({ frequency: "daily", start_date: startedAgo, description: `${label} B`, paid_by: erin }),
  ];
  const [runA, runB] = await trio("Runner first");
  const runnerCreated = await runner();
  const wrapperAfter = await asUser(erin, async () => (await q(`select public.materialise_my_recurring() as n`))[0].n);
  const wrapperAgain = await asUser(erin, async () => (await q(`select public.materialise_my_recurring() as n`))[0].n);
  const shapeA = await dates(runA);
  check(
    runnerCreated === 12 && wrapperAfter === 0 && wrapperAgain === 0 &&
      shapeA.length === 6 && same(shapeA, await dates(runB)) &&
      (await sched(runA)).next_index === 6 && (await sched(runB)).next_index === 6,
    "runner then wrapper (twice): one row per schedule per date, cursor unchanged on the repeats"
  );
  await quiesce();
  const [wrapA, wrapB] = await trio("Wrapper first");
  const outsider = await mk({
    group_id: otherGroupId, frequency: "daily", start_date: startedAgo, description: "Elsewhere",
    splits: JSON.stringify(half(dan, fay)),
  });
  const wrapperFirst = await asUser(erin, async () => (await q(`select public.materialise_my_recurring() as n`))[0].n);
  check(
    wrapperFirst === 12 && same(await dates(wrapA), shapeA) && same(await dates(wrapB), shapeA),
    "wrapper then runner gives exactly the rows the runner-first order gave"
  );
  check(
    (await rowsOf(outsider)).length === 0 && (await sched(outsider)).next_index === 0,
    "the wrapper only touches schedules the caller belongs to (a group Erin is not in is untouched)"
  );
  const gusRan = await asUser(gus, async () => (await q(`select public.materialise_my_recurring() as n`))[0].n);
  const runnerAfter = await runner();
  check(
    gusRan === 0 && runnerAfter === 6 && (await rowsOf(outsider)).length === 6 && (await runner()) === 0,
    "a user in no group creates nothing, and the runner then creates the rest once (second run 0)"
  );
  const contactDaily = await mkContact({ frequency: "daily", start_date: startedAgo, description: "Contact daily" });
  const outsiderContact = await asUser(gus, async () => (await q(`select public.materialise_my_recurring() as n`))[0].n);
  check(
    outsiderContact === 0 && (await rowsOf(contactDaily, "contact_expenses")).length === 0,
    "a non-participant's catch-up leaves a contact schedule alone"
  );
  const participant = await asUser(hal, async () => (await q(`select public.materialise_my_recurring() as n`))[0].n);
  check(participant === 6 && (await sched(contactDaily)).next_index === 6, "a participant's catch-up creates the contact schedule's occurrences");

  const engineSource = (await q(`select pg_get_functiondef('public.materialise_my_recurring()'::regprocedure) as def`))[0].def;
  const runnerSource = (await q(`select pg_get_functiondef('public._materialise_recurring(timestamptz, uuid)'::regprocedure) as def`))[0].def;
  check(
    /_materialise_recurring\(/.test(engineSource) && !/_materialise_one\(/.test(engineSource) &&
      !/insert into/i.test(engineSource) && /_materialise_one\(/.test(runnerSource),
    "the wrapper calls the cron runner (which calls _materialise_one) and has no engine code of its own"
  );

  // ---- Security --------------------------------------------------------------------------------
  const privateCalls = [
    [`select public._materialise_one($1::uuid, now())`, [fx]],
    [`select public._materialise_recurring(now(), null)`, []],
    [`select public._materialise_recurring()`, []],
    [`select public._schedule_rate(null::public.recurring_schedules)`, []],
    [`select public._occurrence_date(current_date, 'daily', 1)`, []],
    [`select public._convert_splits_to_base('[]'::jsonb, 1, 0)`, []],
  ];
  let deniedForAuthed = 0;
  let deniedForAnon = 0;
  for (const [sql, params] of privateCalls) {
    if ((await asUser(erin, () => code(() => db.query(sql, params)))) === "42501") deniedForAuthed += 1;
    await db.exec("set role anon");
    if ((await code(() => db.query(sql, params))) === "42501") deniedForAnon += 1;
    await db.exec("reset role");
  }
  check(
    deniedForAuthed === privateCalls.length && deniedForAnon === privateCalls.length,
    "clients (authenticated and anon) get permission denied on every private engine function"
  );
  await db.exec("set role anon");
  const anonWrapper = await code(() => db.query(`select public.materialise_my_recurring()`));
  await db.exec("reset role");
  check(anonWrapper === "42501", "anon cannot call materialise_my_recurring");
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '', false)`);
  let noUser = "";
  try {
    await db.query(`select public.materialise_my_recurring()`);
  } catch (error) {
    noUser = error.message;
  }
  await db.exec("reset role");
  check(noUser === "Not authenticated", "the wrapper raises 'Not authenticated' without a user");

  const allowed = new Set(["completed", "member left", "invalid"]);
  const { rows: reasons } = await db.query(`select distinct stop_reason, last_error from public.recurring_schedules`);
  const genericErrors = reasons.map((r) => r.last_error).filter((e) => e !== null);
  check(
    reasons.every((r) => r.stop_reason === null || allowed.has(r.stop_reason)) &&
      genericErrors.every((e) => !/uuid|violates|constraint|relation|time zone|serialize|must|split|exception/i.test(e)),
    `no stop_reason or last_error carries a raw database message (${[...new Set(reasons.map((r) => r.stop_reason))].join(", ")})`
  );
  const [{ n: crossed }] = await q(`
    select count(*)::int as n from public.expenses e join public.recurring_schedules s on s.id = e.schedule_id
    where e.group_id is distinct from s.group_id
  `);
  const [{ n: total }] = await q(`select count(*)::int as n from public.expenses where schedule_id is not null`);
  check(total > 100 && crossed === 0, `every engine-created expense has its schedule's group_id (${total} checked)`);
  // ---- A run that changes nothing writes nothing -----------------------------------------------
  // Every update of a schedule row is a WAL record, a row lock and a realtime event
  // for the whole group, so a no-op run (every app open) must leave the row untouched.
  await quiesce();
  const xmins = async (ids) =>
    Object.fromEntries(
      (await q(`select id, xmin::text as x from public.recurring_schedules where id = any($1::uuid[])`, [ids])).map((r) => [r.id, r.x])
    );
  const settled = await mk({ frequency: "daily", start_date: await plus(-2), description: "Settled" });
  const settledFx = await mk({
    frequency: "daily", start_date: await plus(-2), description: "Settled EUR", currency: "EUR", last_exchange_rate: "1.1234567891",
  });
  const settledContact = await mkContact({ frequency: "daily", start_date: await plus(-2), description: "Settled pair" });
  const notDue = await mk({ start_date: await plus(60), description: "Far away" });
  const notDueFx = await mk({ start_date: await plus(60), description: "Far away EUR", currency: "EUR", last_exchange_rate: "0.8" });
  const ids = [settled, settledFx, settledContact, notDue, notDueFx];
  const untouched = await xmins([notDue, notDueFx]);
  await runner();
  check(
    (await rowsOf(settled)).length >= 4 && (await sched(settledFx)).next_index === (await rowsOf(settled)).length &&
      (await rowsOf(settledContact, "contact_expenses")).length === (await rowsOf(settled)).length,
    "the first run creates the due occurrences (fixture for the no-op checks)"
  );
  const before = await xmins(ids);
  check(
    before[notDue] === untouched[notDue] && before[notDueFx] === untouched[notDueFx],
    "a run with nothing due leaves a schedule row untouched, including a foreign-currency one"
  );
  check((await runner()) === 0, "a repeat run creates nothing");
  await asUser(erin, () => db.query(`select public.materialise_my_recurring()`));
  await asUser(hal, () => db.query(`select public.materialise_my_recurring()`));
  const after = await xmins(ids);
  check(
    ids.every((id) => after[id] === before[id]),
    "repeat runs through the runner and the wrapper do not rewrite any schedule row (xmin unchanged)"
  );
  // The counters still clear when the retry has nothing to create.
  await db.query(`update public.recurring_schedules set failed_runs = 3 where id = $1`, [notDue]);
  await db.query(`update public.recurring_schedules set last_error = 'Could not create the latest occurrence; it will be retried.' where id = $1`, [notDueFx]);
  await runner();
  const [healedA] = await q(`select failed_runs, last_error from public.recurring_schedules where id = $1`, [notDue]);
  const [healedB] = await q(`select failed_runs, last_error from public.recurring_schedules where id = $1`, [notDueFx]);
  check(
    healedA.failed_runs === 0 && healedB.last_error === null,
    "a run that finds nothing due still clears a leftover failed_runs or last_error"
  );
  await quiesce();

  const [{ n: crossedPairs }] = await q(`
    select count(*)::int as n from public.contact_expenses e join public.recurring_schedules s on s.id = e.schedule_id
    where (e.user_lo, e.user_hi) is distinct from (s.user_lo, s.user_hi)
  `);
  check(crossedPairs === 0, "every engine-created contact expense has its schedule's pair");
}
