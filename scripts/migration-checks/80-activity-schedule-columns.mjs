// get_recent_activity and get_upcoming_expenses also return schedule_id and
// occurrence_date (the last two columns) so the client can mark a row as
// repeating and show the schedule's calendar date. Both are null for an expense
// no schedule made. Neither function returns payments or contact rows.
//
// Dates are offsets from the database's own UTC today (schedules use tz 'UTC'),
// so nothing depends on when the check runs.

const EXISTING_COLUMNS =
  "id uuid, description text, amount numeric, currency text, date timestamp with time zone, " +
  "paid_by uuid, group_id uuid, payer jsonb, groups jsonb, expense_splits jsonb";

export default async function activityScheduleColumns({ db, asUser, signUp, check }) {
  const amy = await signUp("asc-amy@example.com", "Amy");
  const ben = await signUp("asc-ben@example.com", "Ben");
  const cat = await signUp("asc-cat@example.com", "Cat");

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

  const groupId = await asUser(amy, async () =>
    (await q(`select * from public.create_group_with_members($1, $2::text[], 'USD')`, [
      "Activity columns",
      ["asc-ben@example.com", "asc-cat@example.com"],
    ]))[0].id
  );

  const schedule = await asUser(amy, async () =>
    (await q(
      `select * from public.create_recurring_schedule($1, null, $2, 30, 'Daily rent', 'housing', 'equal'::public.split_type,
         $3::jsonb, 'USD', 1, $4::date, 'UTC', 'daily', null, null)`,
      [
        groupId,
        amy,
        JSON.stringify([
          { userId: amy, amount: 15 },
          { userId: ben, amount: 15 },
        ]),
        await day(-1),
      ]
    ))[0]
  );

  const plain = await asUser(amy, async () =>
    (await q(
      `select id from public.create_expense_with_splits($1, $2, 12, 'Plain lunch', null, 'exact', $3::jsonb,
         now() - interval '1 hour', 'USD', 1)`,
      [
        groupId,
        amy,
        JSON.stringify([
          { userId: amy, amount: 6, baseAmount: 6 },
          { userId: ben, amount: 6, baseAmount: 6 },
        ]),
      ]
    ))[0].id
  );
  const plainFuture = await asUser(amy, async () =>
    (await q(
      `select id from public.create_expense_with_splits($1, $2, 8, 'Plain later', null, 'exact', $3::jsonb,
         now() + interval '3 days', 'USD', 1)`,
      [
        groupId,
        amy,
        JSON.stringify([
          { userId: amy, amount: 4, baseAmount: 4 },
          { userId: ben, amount: 4, baseAmount: 4 },
        ]),
      ]
    ))[0].id
  );

  const read = (uid, fn) =>
    asUser(uid, () =>
      q(
        `select id, description, schedule_id, to_char(occurrence_date, 'YYYY-MM-DD') as od,
           pg_typeof(occurrence_date)::text as od_type, pg_typeof(schedule_id)::text as sid_type
         from public.${fn}(50)`
      )
    );
  const recent = await read(amy, "get_recent_activity");
  const upcoming = await read(amy, "get_upcoming_expenses");
  const recentRent = recent.filter((r) => r.description === "Daily rent");
  const upcomingRent = upcoming.filter((r) => r.description === "Daily rent");

  // ---- Scheduled occurrences carry the link ---------------------------------
  check(
    JSON.stringify(recentRent.map((r) => [r.od, r.schedule_id])) ===
      JSON.stringify([
        [await day(0), schedule.id],
        [await day(-1), schedule.id],
      ]),
    "get_recent_activity returns schedule_id and occurrence_date for the past occurrences of a schedule"
  );
  check(
    JSON.stringify(upcomingRent.map((r) => [r.od, r.schedule_id])) ===
      JSON.stringify([
        [await day(1), schedule.id],
        [await day(2), schedule.id],
      ]),
    "get_upcoming_expenses returns schedule_id and occurrence_date for the future occurrences of a schedule"
  );
  check(
    [...recent, ...upcoming].every((r) => r.sid_type === "uuid" && r.od_type === "date"),
    "schedule_id is a uuid and occurrence_date a date in both functions"
  );

  // ---- Unscheduled expenses have nulls --------------------------------------
  const plainRecent = recent.find((r) => r.id === plain);
  const plainUpcoming = upcoming.find((r) => r.id === plainFuture);
  check(
    plainRecent && plainRecent.schedule_id === null && plainRecent.od === null,
    "an unscheduled past expense has null schedule_id and occurrence_date in get_recent_activity"
  );
  check(
    plainUpcoming && plainUpcoming.schedule_id === null && plainUpcoming.od === null,
    "an unscheduled future expense has null schedule_id and occurrence_date in get_upcoming_expenses"
  );

  // ---- The link follows the expense row, not the schedule's state -----------
  const rentRow = recentRent[0];
  await db.query(`update public.expenses set hand_edited = true where id = $1`, [rentRow.id]);
  const afterEdit = (await read(amy, "get_recent_activity")).find((r) => r.id === rentRow.id);
  check(
    afterEdit && afterEdit.schedule_id === schedule.id && afterEdit.od === rentRow.od,
    "a hand-edited occurrence still reports its schedule"
  );
  await asUser(amy, () => db.query(`select * from public.stop_recurring_schedule($1)`, [schedule.id]));
  const afterStop = await read(amy, "get_recent_activity");
  check(
    afterStop.filter((r) => r.description === "Daily rent" && r.schedule_id === schedule.id).length >= 1,
    "occurrences of a stopped schedule keep their schedule_id"
  );

  // ---- Visibility rules are unchanged ----------------------------------------
  check(
    (await read(cat, "get_recent_activity")).length === 0 && (await read(cat, "get_upcoming_expenses")).length === 0,
    "a group member who paid for and shares in nothing still sees no rows"
  );
  check(
    (await read(ben, "get_recent_activity")).some((r) => r.schedule_id === schedule.id),
    "a member who shares in the occurrence sees its schedule_id"
  );
  check(
    (await errorOf(db.query(`select * from public.get_recent_activity()`))) === "Not authenticated" &&
      (await errorOf(db.query(`select * from public.get_upcoming_expenses()`))) === "Not authenticated",
    "both functions still need a signed-in user"
  );

  // ---- One signature each, columns appended last, grants like an untouched RPC
  const fns = await q(
    `select p.proname, pg_get_function_result(p.oid) as result, pg_get_function_identity_arguments(p.oid) as args,
       coalesce(p.proacl::text, '') as acl, p.prosecdef as secdef,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('get_recent_activity', 'get_upcoming_expenses', 'get_group_balances')
     order by p.proname`
  );
  const byName = (name) => fns.filter((r) => r.proname === name);
  const [recentFn] = byName("get_recent_activity");
  const [upcomingFn] = byName("get_upcoming_expenses");
  const [untouched] = byName("get_group_balances");
  check(
    byName("get_recent_activity").length === 1 &&
      byName("get_upcoming_expenses").length === 1 &&
      recentFn.args === "p_limit integer" &&
      upcomingFn.args === "p_limit integer",
    "exactly one get_recent_activity(integer) and one get_upcoming_expenses(integer)"
  );
  const expectedResult = `TABLE(${EXISTING_COLUMNS}, schedule_id uuid, occurrence_date date)`;
  check(
    recentFn.result === expectedResult && upcomingFn.result === expectedResult,
    "both functions keep every existing column in order and append schedule_id, occurrence_date last"
  );
  check(
    recentFn.secdef && upcomingFn.secdef && recentFn.acl === untouched.acl && upcomingFn.acl === untouched.acl &&
      recentFn.auth_exec === untouched.auth_exec && upcomingFn.auth_exec === untouched.auth_exec &&
      recentFn.anon_exec === untouched.anon_exec && upcomingFn.anon_exec === untouched.anon_exec,
    "both stay SECURITY DEFINER with the same execute grants as an untouched RPC (get_group_balances)"
  );
}
