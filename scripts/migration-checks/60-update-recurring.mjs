// update_recurring_schedule: edits the payload and limits of a series. Changes
// reach FUTURE occurrences only: pending rows (schedule_id set, date > now(),
// hand_edited = false) are rewritten through the private update helpers with
// p_mark_hand_edited = false, past rows and hand-edited pending rows are left
// alone, pending rows beyond a lowered limit are deleted, and the engine tops
// the series up afterwards. Schedules are inserted as the owner (the create RPC
// is another piece) and filled with _materialise_one at explicit horizons.
// Every fixture date is derived from the database clock (a yearly series that
// starts five years ago, so five occurrences are past and the next ones are
// pending), and every past/pending expectation from date > now(), so the suite
// holds at any date.
//
// Locking (documented, not testable on a single connection): the function takes
// `select ... for update` on the schedule row first, so it serialises against
// cron / the catch-up (_materialise_one locks the same row) and against stop.

export default async function updateRecurring({ db, asUser, signUp, rejects, check }) {
  const dan = await signUp("ur-dan@example.com", "Dan");
  const erin = await signUp("ur-erin@example.com", "Erin");
  const fay = await signUp("ur-fay@example.com", "Fay");
  const gus = await signUp("ur-gus@example.com", "Gus");
  const hal = await signUp("ur-hal@example.com", "Hal");
  const ivy = await signUp("ur-ivy@example.com", "Ivy");
  const jo = await signUp("ur-jo@example.com", "Jo");
  const kim = await signUp("ur-kim@example.com", "Kim");

  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const START = (await q(`select ((now() at time zone 'utc')::date - interval '5 years' + interval '2 days')::date::text as d`))[0].d;
  const HZ = (await q(`select (now() + interval '4 years 10 days')::text as t`))[0].t;
  const fut = async (years) =>
    (await q(`select ((now() at time zone 'utc')::date + make_interval(years => $1::int))::date::text as d`, [years]))[0].d;
  const occ = async (start, n) => (await q(`select public._occurrence_date($1::date, 'yearly', $2::int)::text as d`, [start, n]))[0].d;
  const makeGroup = (name, emails, currency = "USD") =>
    asUser(dan, async () => (await db.query(`select * from public.create_group_with_members($1, $2::text[], $3)`, [name, emails, currency])).rows[0].id);
  const groupId = await makeGroup("Upd", ["ur-erin@example.com", "ur-fay@example.com"]);
  const befriend = async (a, aEmail, b, bEmail) => {
    await asUser(a, () => db.query(`select public.send_contact_request($1)`, [bEmail]));
    const [req] = await q(`select id from public.contact_requests where requester_id = $1 and recipient_id = $2`, [a, b]);
    await asUser(b, () => db.query(`select public.respond_contact_request($1, true)`, [req.id]));
    return a < b ? [a, b] : [b, a];
  };
  const [lo, hi] = await befriend(hal, "ur-hal@example.com", ivy, "ur-ivy@example.com");
  const [lo2, hi2] = await befriend(jo, "ur-jo@example.com", kim, "ur-kim@example.com");

  const mk = async (fields = {}) => {
    const row = {
      kind: "group", group_id: groupId, created_by: dan, paid_by: dan, description: "Rent",
      amount: 30, currency: "USD", last_exchange_rate: 1, split_type: "equal",
      splits: JSON.stringify([{ userId: dan, amount: 15, baseAmount: 15 }, { userId: erin, amount: 15, baseAmount: 15 }]),
      start_date: START, tz: "UTC", frequency: "yearly", ...fields,
    };
    const cols = Object.keys(row);
    const { rows } = await db.query(
      `insert into public.recurring_schedules (${cols.join(", ")}) values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row)
    );
    return rows[0].id;
  };
  const mkContact = (fields = {}) =>
    mk({
      kind: "contact", group_id: null, user_lo: lo, user_hi: hi, created_by: hal, paid_by: ivy, amount: 20,
      splits: JSON.stringify([{ userId: hal, amount: 10, baseAmount: 10 }, { userId: ivy, amount: 10, baseAmount: 10 }]),
      ...fields,
    });
  const sched = async (id) => (await q(`select * from public.recurring_schedules where id = $1`, [id]))[0];
  const one = async (id, horizon) =>
    (await q(`select public._materialise_one($1::uuid, $2::timestamptz) as n`, [id, horizon]))[0].n;
  const msg = async (fn) => {
    try {
      await fn();
      return "(no error)";
    } catch (error) {
      return error.message;
    }
  };
  const errcode = async (fn) => {
    try {
      await fn();
      return "(no error)";
    } catch (error) {
      return error.code;
    }
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Rows of one schedule with their splits and whether they are pending now.
  const snapshot = async (id, table = "expenses") => {
    const splits = table === "expenses" ? "expense_splits" : "contact_expense_splits";
    const rows = await q(
      `select e.id, to_char(e.occurrence_date, 'YYYY-MM-DD') as d, e.date > now() as pending, to_jsonb(e) as row,
         coalesce((select jsonb_agg(jsonb_build_object('u', s.user_id, 'a', s.amount, 'b', s.base_amount) order by s.user_id)
           from public.${splits} s where s.expense_id = e.id), '[]'::jsonb) as splits
       from public.${table} e where e.schedule_id = $1 order by e.occurrence_date`,
      [id]
    );
    return rows;
  };
  const rewritable = (r) => r.pending && !r.row.hand_edited;
  const sorted = (splits) => [...splits].sort((x, y) => (x.u < y.u ? -1 : 1));
  // Every rewritable row carries exactly the schedule's stored payload.
  const agrees = async (id, table = "expenses") => {
    const s = await sched(id);
    const want = sorted(s.splits.map((x) => ({ u: x.userId, a: Number(x.amount), b: Number(x.baseAmount) })));
    const rows = (await snapshot(id, table)).filter(rewritable);
    return (
      rows.length > 0 &&
      rows.every((r) => {
        const got = sorted(r.splits.map((x) => ({ u: x.u, a: Number(x.a), b: Number(x.b) })));
        return (
          r.row.description === s.description && Number(r.row.amount) === Number(s.amount) &&
          (r.row.category ?? null) === (s.category ?? null) && r.row.paid_by === s.paid_by &&
          r.row.split_type === s.split_type && r.row.currency === s.currency && r.row.hand_edited === false &&
          same(got, want) && Math.abs(got.reduce((t, x) => t + x.b, 0) - Number(r.row.base_amount)) < 0.0001
        );
      })
    );
  };

  const upd = (uid, id, args = {}) =>
    asUser(uid, async () => {
      const keys = Object.keys(args);
      const named = keys.map((k, i) => `, p_${k} => $${i + 2}`).join("");
      const { rows } = await db.query(
        `select * from public.update_recurring_schedule(p_schedule_id => $1::uuid${named})`,
        [id, ...keys.map((k) => (k === "splits" ? JSON.stringify(args[k]) : args[k]))]
      );
      return rows[0];
    });
  const handEdit = (uid, rowId, description) =>
    asUser(uid, () =>
      db.query(
        `select public.update_expense_with_splits($1, $2, 99, $3, null, 'equal',
           $4::jsonb)`,
        [rowId, dan, description, JSON.stringify([{ userId: dan, amount: 99, baseAmount: 99 }])]
      )
    );

  // ---- The function: one signature, definer, pinned, authenticated only -----------
  const { rows: fns } = await db.query(`
    select p.oid, pg_get_function_arguments(p.oid) as args, p.prosecdef,
      coalesce(p.proconfig::text, '') like '%search_path=public, pg_temp%' as pinned,
      has_function_privilege('authenticated', p.oid, 'execute') as authed,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      coalesce(p.proacl::text, '') ~ '(^\\{|,)=X' as public_exec
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_recurring_schedule'
  `);
  check(fns.length === 1, "exactly one update_recurring_schedule exists (no stray overload)");
  check(
    fns.length === 1 && fns[0].prosecdef && fns[0].pinned && fns[0].authed && !fns[0].anon && !fns[0].public_exec,
    "update_recurring_schedule is SECURITY DEFINER with search_path = public, pg_temp, executable by authenticated only"
  );
  check(
    fns.length === 1 &&
      fns[0].args ===
        "p_schedule_id uuid, p_amount numeric DEFAULT NULL::numeric, p_description text DEFAULT NULL::text, p_category text DEFAULT NULL::text, " +
          "p_split_type split_type DEFAULT NULL::split_type, p_splits jsonb DEFAULT NULL::jsonb, p_paid_by uuid DEFAULT NULL::uuid, " +
          "p_end_date date DEFAULT NULL::date, p_max_count integer DEFAULT NULL::integer, p_clear_end_date boolean DEFAULT false, " +
          "p_clear_max_count boolean DEFAULT false",
    `the signature is the plan's contract (names, order, defaults)${fns.length === 1 ? ": " + fns[0].args : ""}`
  );

  // ---- A yearly series whose first years are past: edits rewrite pending rows only -
  const Y = await mk({ description: "Rent" });
  check((await one(Y, HZ)) === 10, "fixture: a yearly series that started five years ago and runs to four years ahead has 10 occurrences");
  const y0 = await snapshot(Y);
  const pending0 = y0.filter((r) => r.pending);
  const past0 = y0.filter((r) => !r.pending);
  check(pending0.length >= 3 && past0.length >= 1, `fixture: the series straddles now (${past0.length} past, ${pending0.length} pending)`);
  const handRow = pending0[pending0.length - 1];
  await handEdit(dan, handRow.id, "Edited by hand");
  const y1 = await snapshot(Y);
  check(
    y1.find((r) => r.id === handRow.id).row.hand_edited === true && y1.filter(rewritable).length === pending0.length - 1,
    "fixture: a member's manual edit marks that pending row hand_edited"
  );
  const before1 = y1;
  const ret1 = await upd(dan, Y, {
    amount: 60, description: "  Rent v2  ",
    splits: [{ userId: dan, amount: 40 }, { userId: erin, amount: 20 }],
  });
  const s1 = await sched(Y);
  const after1 = await snapshot(Y);
  check(
    ret1.id === Y && ret1.description === "Rent v2" && Number(ret1.amount) === 60 && same(ret1, s1) &&
      Number(s1.next_index) === 10 && s1.stopped_at === null,
    "the updated schedule row is returned (trimmed description, amount 60) and is the stored row; cursor unchanged"
  );
  check(
    same(s1.splits.map((x) => [x.userId, Number(x.amount), Number(x.baseAmount)]).sort(), [[dan, 40, 40], [erin, 20, 20]].sort()),
    "the stored splits are normalised to {userId, amount, baseAmount}"
  );
  check(
    after1.filter(rewritable).length === pending0.length - 1 &&
      after1.filter(rewritable).every((r) => r.row.description === "Rent v2" && Number(r.row.amount) === 60 &&
        r.splits.map((x) => Number(x.a)).sort((a, b) => a - b).join() === "20,40"),
    "pending non-hand-edited rows were rewritten with the new description, amount and splits"
  );
  check(
    same(after1.filter((r) => !r.pending), before1.filter((r) => !r.pending)),
    "past rows are untouched (rows and splits identical)"
  );
  check(
    same(after1.find((r) => r.id === handRow.id), before1.find((r) => r.id === handRow.id)),
    "a hand-edited pending row is untouched by the schedule edit"
  );
  check(after1.every((r) => r.row.hand_edited === (r.id === handRow.id)), "rewritten rows are not marked hand_edited");
  check(await agrees(Y), "stored payload and every rewritable row agree");

  await upd(dan, Y, { description: "Rent v3" });
  const after2 = await snapshot(Y);
  check(
    after2.filter(rewritable).length === pending0.length - 1 &&
      after2.filter(rewritable).every((r) => r.row.description === "Rent v3" && Number(r.row.amount) === 60) &&
      after2.every((r) => r.row.hand_edited === (r.id === handRow.id)),
    "a second schedule edit rewrites the pending rows again (the first edit did not freeze them)"
  );
  await upd(fay, Y, { paid_by: erin, category: "Housing", split_type: "exact" });
  const s3 = await sched(Y);
  check(
    s3.paid_by === erin && s3.category === "Housing" && s3.split_type === "exact" && s3.description === "Rent v3" &&
      (await snapshot(Y)).filter(rewritable).every((r) => r.row.paid_by === erin && r.row.category === "Housing" && r.row.split_type === "exact") &&
      (await agrees(Y)),
    "a third edit by another member changes payer, category and split type on the schedule and the pending rows; null keeps the rest"
  );
  check(
    same((await snapshot(Y)).filter((r) => !r.pending), before1.filter((r) => !r.pending)) &&
      same((await snapshot(Y)).find((r) => r.id === handRow.id), before1.find((r) => r.id === handRow.id)),
    "after three edits past rows and the hand-edited row are still exactly as they were"
  );

  // Deleting a pending occurrence is a skip: the cursor, not the rows, decides what exists.
  const skipped = (await snapshot(Y)).filter(rewritable)[0];
  await db.query(`delete from public.expenses where id = $1`, [skipped.id]);
  await upd(dan, Y, { description: "Rent v4" });
  const afterSkip = await snapshot(Y);
  check(
    !afterSkip.some((r) => r.d === skipped.d) && Number((await sched(Y)).next_index) === 10 &&
      afterSkip.filter(rewritable).every((r) => r.row.description === "Rent v4"),
    "an edit does not bring back a deleted (skipped) pending occurrence and still rewrites the rest"
  );

  // ---- Rejections leave everything as it was ---------------------------------------
  const frozenSched = await sched(Y);
  const frozenRows = await snapshot(Y);
  const strangerSplit = [{ userId: dan, amount: 30 }, { userId: gus, amount: 30 }];
  const bad = [
    ["amount without splits", { amount: 10 }, /Amount and splits must be changed together/],
    ["splits without amount", { splits: [{ userId: dan, amount: 10 }] }, /Amount and splits must be changed together/],
    ["a zero amount", { amount: 0, splits: [{ userId: dan, amount: 0 }] }, /greater than zero/],
    ["a blank description", { description: "   " }, /Expense description is required/],
    ["splits that do not add up", { amount: 10, splits: [{ userId: dan, amount: 4 }, { userId: erin, amount: 4 }] }, /add up to the expense total/],
    ["a negative split", { amount: 10, splits: [{ userId: dan, amount: 15 }, { userId: erin, amount: -5 }] }, /cannot be negative/],
    ["a split user outside the group", { amount: 60, splits: strangerSplit }, /Every split user must be a group member/],
    ["the same split user twice", { amount: 10, splits: [{ userId: dan, amount: 5 }, { userId: dan, amount: 5 }] }, /only once/],
    ["an empty split list", { amount: 10, splits: [] }, /At least one split is required/],
    ["a payer outside the group", { paid_by: gus }, /Expense payer must be a group member/],
    ["a zero max_count", { max_count: 0 }, /at least 1/],
    ["an end date before the start date", { end_date: "2019-12-31" }, /cannot be before the start date/],
    ["an end date together with clearing it", { end_date: "2040-01-01", clear_end_date: true }, /either a new end date or clear it/],
    ["a max_count together with clearing it", { max_count: 5, clear_max_count: true }, /either a new number of occurrences or clear it/],
  ];
  for (const [name, args, pattern] of bad) {
    const m = await msg(() => upd(dan, Y, args));
    check(pattern.test(m), `rejected: ${name} (${m})`);
  }
  check(
    same(await sched(Y), frozenSched) && same(await snapshot(Y), frozenRows),
    "every rejected edit left the schedule and all its rows exactly as they were"
  );

  // ---- Authorization -----------------------------------------------------------------
  const strangerMsg = await msg(() => upd(gus, Y, { description: "Hacked" }));
  const missingMsg = await msg(() => upd(dan, "00000000-0000-0000-0000-000000000000", { description: "x" }));
  check(
    /Schedule not found/.test(strangerMsg) && strangerMsg === missingMsg,
    "a non-member gets the same 'Schedule not found' as for a missing schedule (existence is not revealed)"
  );
  await db.exec("set role anon");
  const anonCode = await errcode(() => db.query(`select public.update_recurring_schedule($1)`, [Y]));
  await db.exec("reset role");
  check(anonCode === "42501", "anon cannot call update_recurring_schedule (permission denied)");
  await db.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '', false)`);
  const noUid = await msg(() => db.query(`select public.update_recurring_schedule($1, p_description => 'x')`, [Y]));
  await db.exec(`reset role`);
  check(/Not authenticated/.test(noUid), "authenticated without a user id is refused with 'Not authenticated'");
  check(same(await sched(Y), frozenSched), "the unauthorised attempts changed nothing");

  // ---- Stopped and completed schedules cannot be edited -------------------------------
  const stoppedId = await mk({ description: "Stopped one" });
  await db.query(`update public.recurring_schedules set stopped_at = now(), stop_reason = 'stopped' where id = $1`, [stoppedId]);
  const stoppedMsg = await msg(() => upd(dan, stoppedId, { description: "Revived" }));
  check(
    /stopped and can no longer be edited/.test(stoppedMsg) && (await sched(stoppedId)).description === "Stopped one",
    `a stopped schedule is refused with a clear message (${stoppedMsg})`
  );

  // ---- Limits: clearing, raising ---------------------------------------------------------
  const L = await mk({ max_count: 20, end_date: await fut(30), description: "Limits" });
  await one(L, HZ);
  const lRows = await snapshot(L);
  await upd(dan, L, { clear_end_date: true });
  const l1 = await sched(L);
  check(l1.end_date === null && l1.max_count === 20 && l1.stopped_at === null, "p_clear_end_date clears the end date and nothing else");
  await upd(dan, L, { clear_max_count: true });
  const l2 = await sched(L);
  check(l2.max_count === null && l2.end_date === null && l2.stopped_at === null, "p_clear_max_count clears the max count");
  const lEnd = await fut(40);
  await upd(dan, L, { end_date: lEnd, clear_max_count: true });
  const l3 = (await q(`select to_char(end_date, 'YYYY-MM-DD') as e, max_count from public.recurring_schedules where id = $1`, [L]))[0];
  check(l3.e === lEnd && l3.max_count === null, "a limit can be set while the other is cleared in one call");
  check(same(await snapshot(L), lRows), "clearing or raising limits creates and deletes nothing (the cursor is where it was)");

  const R = await mk({ start_date: await fut(3), max_count: 4, description: "Raise" });
  await one(R, HZ);
  await upd(dan, R, { max_count: 10 });
  const rRow = await sched(R);
  check(rRow.max_count === 10 && rRow.stopped_at === null && Number(rRow.next_index) === 2, "raising max_count keeps the schedule active at its cursor");

  // ---- Limits: lowering ----------------------------------------------------------------------
  const M = await mk({ max_count: 20, description: "Count lowered" });
  await one(M, HZ);
  const mBefore = await snapshot(M);
  const mHand = mBefore[mBefore.length - 1];
  await handEdit(dan, mHand.id, "Mine");
  const mHandBefore = (await snapshot(M)).find((r) => r.id === mHand.id);
  const m7 = await occ(START, 7);
  await upd(dan, M, { max_count: 7 });
  const mAfter = await snapshot(M);
  const mGone = mBefore.filter((r) => rewritable(r) && r.d >= m7 && r.id !== mHand.id).map((r) => r.id);
  check(
    mGone.length >= 1 && mAfter.every((r) => !mGone.includes(r.id)) &&
      mAfter.length === mBefore.length - mGone.length &&
      mBefore.filter((r) => !mGone.includes(r.id) && r.id !== mHand.id).every((r) => mAfter.some((a) => a.id === r.id)),
    "lowering max_count to 7 deletes the pending non-hand-edited rows beyond occurrence 7 and nothing else"
  );
  check(same(mAfter.find((r) => r.id === mHand.id), mHandBefore), "a hand-edited pending row beyond the new limit stays and still counts at its date");
  const mRow = await sched(M);
  check(
    mRow.max_count === 7 && mRow.stopped_at !== null && mRow.stop_reason === "completed" && Number(mRow.next_index) === 10,
    "the series is completed (stop_reason 'completed') and the cursor stays where it was"
  );
  check(
    same(mAfter.filter((r) => !r.pending), mBefore.filter((r) => !r.pending)),
    "lowering the limit does not touch past rows"
  );
  check(
    /stopped and can no longer be edited/.test(await msg(() => upd(dan, M, { max_count: 30 }))),
    "a completed schedule cannot be raised again"
  );

  const Z = await mk({ max_count: 20, description: "Below made" });
  await one(Z, HZ);
  const zBefore = await snapshot(Z);
  await upd(dan, Z, { max_count: 3 });
  const zAfter = await snapshot(Z);
  check(
    same(zAfter, zBefore.filter((r) => !rewritable(r))) && (await sched(Z)).stop_reason === "completed" &&
      zBefore.filter((r) => !r.pending).length > 3,
    "a max_count below the number already created completes the schedule, deletes every pending row and no past row"
  );

  const E = await mk({ end_date: await fut(30), description: "End lowered" });
  const eEnd = (await q(`select (public._occurrence_date($1::date, 'yearly', 7) + 5)::text as d`, [START]))[0].d;
  await one(E, HZ);
  const eBefore = await snapshot(E);
  await upd(dan, E, { end_date: eEnd });
  const eAfter = await snapshot(E);
  const eGone = eBefore.filter((r) => rewritable(r) && r.d > eEnd);
  check(
    eGone.length >= 1 && same(eAfter, eBefore.filter((r) => !eGone.some((g) => g.id === r.id))) &&
      (await sched(E)).stop_reason === "completed",
    "lowering end_date deletes the pending rows after it, keeps the others and completes the series"
  );

  // ---- The engine tops the series up after an edit ------------------------------------------
  const T = await mk({
    start_date: (await q(`select ((now() at time zone 'utc')::date + 1)::text as d`))[0].d,
    frequency: "daily", description: "Topup",
  });
  await upd(dan, T, { description: "Topped up" });
  const tRows = await snapshot(T);
  check(
    tRows.length === 2 && tRows.every((r) => r.row.description === "Topped up" && r.pending) && Number((await sched(T)).next_index) === 2,
    "an edit also runs the engine: occurrences within 48 hours are created with the edited payload"
  );

  // ---- Cross-currency: rewritten rows convert at the schedule's rate ---------------------------
  const X = await mk({
    currency: "EUR", last_exchange_rate: 1.5, description: "Euro",
    splits: JSON.stringify([{ userId: dan, amount: 15, baseAmount: 1 }, { userId: erin, amount: 15, baseAmount: 1 }]),
  });
  await one(X, HZ);
  await upd(dan, X, {
    amount: 10,
    splits: [{ userId: dan, amount: 3.33 }, { userId: erin, amount: 3.33 }, { userId: fay, amount: 3.34 }],
  });
  const xRows = (await snapshot(X)).filter(rewritable);
  const xBases = xRows.length && xRows[0].splits.map((x) => Number(x.b)).sort((a, b) => a - b);
  check(
    xRows.length > 0 && xRows.every((r) => Number(r.row.base_amount) === 15 && Number(r.row.exchange_rate) === 1.5 && r.row.currency === "EUR") &&
      same(xBases, [5, 5, 5]) && (await agrees(X)) && Number((await sched(X)).last_exchange_rate) === 1.5,
    "a foreign-currency schedule rewrites rows at its last exchange rate, base amounts add up to the converted total (remainder cent), the rate is unchanged"
  );

  // ---- Contact schedules ----------------------------------------------------------------------------
  const C = await mkContact({ description: "Contact rent" });
  await one(C, HZ);
  const cBefore = await snapshot(C, "contact_expenses");
  const cPending = cBefore.filter((r) => r.pending);
  const cHand = cPending[cPending.length - 1];
  await asUser(ivy, () =>
    db.query(`select public.update_contact_expense_with_splits($1, $2, 99, 'By hand', null, 'equal', $3::jsonb)`, [
      cHand.id, ivy, JSON.stringify([{ userId: ivy, amount: 99, baseAmount: 99 }]),
    ])
  );
  const cHandBefore = (await snapshot(C, "contact_expenses")).find((r) => r.id === cHand.id);
  const cRet = await upd(hal, C, {
    amount: 30, description: "Contact rent v2", splits: [{ userId: hal, amount: 20 }, { userId: ivy, amount: 10 }],
  });
  const cAfter = await snapshot(C, "contact_expenses");
  check(
    cRet.id === C && cRet.description === "Contact rent v2" && cPending.length >= 3 &&
      cAfter.filter(rewritable).length === cPending.length - 1 && (await agrees(C, "contact_expenses")) &&
      cAfter.filter(rewritable).every((r) => Number(r.row.amount) === 30),
    "a contact participant edit rewrites the pending contact expenses"
  );
  check(
    same(cAfter.filter((r) => !r.pending), cBefore.filter((r) => !r.pending)) && same(cAfter.find((r) => r.id === cHand.id), cHandBefore),
    "contact schedule: past rows and the hand-edited pending row are untouched"
  );
  await upd(ivy, C, { description: "Contact rent v3" });
  check(
    (await snapshot(C, "contact_expenses")).filter(rewritable).every((r) => r.row.description === "Contact rent v3") &&
      (await agrees(C, "contact_expenses")),
    "contact schedule: a second edit by the other participant rewrites again"
  );
  const cFrozen = await snapshot(C, "contact_expenses");
  check(
    /Not found|Schedule not found/.test(await msg(() => upd(gus, C, { description: "No" }))) &&
      /Expense payer must be a participant/.test(await msg(() => upd(hal, C, { paid_by: gus }))) &&
      /Every split user must be a participant/.test(
        await msg(() => upd(hal, C, { amount: 20, splits: [{ userId: hal, amount: 10 }, { userId: gus, amount: 10 }] }))
      ) &&
      same(await snapshot(C, "contact_expenses"), cFrozen),
    "contact schedule: a stranger, a non-participant payer and a non-participant split user are refused, nothing changes"
  );
  const K = await mkContact({ user_lo: lo2, user_hi: hi2, created_by: jo, paid_by: kim, description: "Pair two",
    splits: JSON.stringify([{ userId: jo, amount: 10, baseAmount: 10 }, { userId: kim, amount: 10, baseAmount: 10 }]) });
  await one(K, HZ);
  await db.query(`delete from public.contacts where owner_id in ($1, $2) and contact_user_id in ($1, $2)`, [jo, kim]);
  const kMsg = await msg(() => upd(jo, K, { description: "Gone" }));
  check(/accepted contacts/.test(kMsg), `an edit after the contact was removed is refused (${kMsg})`);

  // ---- A member who left: the edit must fix the payload or is refused -------------------------------
  const G = await mk({
    description: "Gone member",
    splits: JSON.stringify([{ userId: dan, amount: 15, baseAmount: 15 }, { userId: fay, amount: 15, baseAmount: 15 }]),
  });
  await one(G, HZ);
  await db.query(`delete from public.group_members where group_id = $1 and user_id = $2`, [groupId, fay]);
  const gMsg = await msg(() => upd(dan, G, { description: "Still includes Fay" }));
  check(
    /Every split user must be a group member/.test(gMsg) && (await sched(G)).description === "Gone member",
    `an edit that leaves a departed member in the splits is refused (${gMsg})`
  );
  await upd(dan, G, { amount: 30, splits: [{ userId: dan, amount: 15 }, { userId: erin, amount: 15 }] });
  check(
    (await agrees(G)) && (await sched(G)).stopped_at === null,
    "an edit that replaces the departed member's split succeeds and the series is consistent again"
  );

  // ---- Atomic: a failure while rewriting rolls back the edit, the deletions and earlier rows -----------
  const A = await mk({ max_count: 20, description: "Atomic" });
  await one(A, HZ);
  const aRows = await snapshot(A);
  const aPending = aRows.filter(rewritable);
  const aSched = await sched(A);
  await db.exec(`
    create function public._ur_boom() returns trigger language plpgsql as $f$
    begin
      if new.description = 'BOOM' and new.occurrence_date = '${aPending[1].d}'::date then
        raise exception 'boom';
      end if;
      return new;
    end $f$;
    create trigger ur_boom before update on public.expenses for each row execute function public._ur_boom();
  `);
  const boom = await msg(() => upd(dan, A, { description: "BOOM", max_count: 10 }));
  await db.exec(`drop trigger ur_boom on public.expenses; drop function public._ur_boom()`);
  check(
    aPending.length >= 3 && /boom/.test(boom) && same(await sched(A), aSched) && same(await snapshot(A), aRows),
    "a failure on the second pending row rolls back everything: schedule, the first rewritten row and the limit deletions"
  );
  check(
    (await q(`select count(*)::int as n from pg_proc where proname = '_ur_boom'`))[0].n === 0,
    "the test trigger is gone"
  );

  await db.query(`update public.recurring_schedules set stopped_at = now(), stop_reason = 'completed' where stopped_at is null`);
}
