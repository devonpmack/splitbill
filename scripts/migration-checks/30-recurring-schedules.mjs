// recurring_schedules: the table, its link columns on both expense tables, and
// who can read it. Fixtures are inserted as the database owner; the engine and
// the RPCs that write schedules come in later pieces.

export const realtimeTables = ["recurring_schedules"];

export default async function recurringSchedules({ db, asUser, signUp, rejects, check }) {
  const dan = await signUp("rs-dan@example.com", "Dan");
  const erin = await signUp("rs-erin@example.com", "Erin");
  const fay = await signUp("rs-fay@example.com", "Fay");
  const gus = await signUp("rs-gus@example.com", "Gus");

  const createGroup = (name) =>
    asUser(dan, async () => {
      const { rows } = await db.query(
        `select * from public.create_group_with_members($1, array['rs-erin@example.com'], 'USD')`,
        [name]
      );
      return rows[0].id;
    });
  const groupId = await createGroup("Rent");

  const { rows: pairRows } = await db.query(
    `select least($1::uuid, $2::uuid) as lo, greatest($1::uuid, $2::uuid) as hi`,
    [erin, fay]
  );
  const { lo, hi } = pairRows[0];

  // Fails with the given constraint name, so a check passes for the right reason.
  const violates = async (promise, constraint) => {
    try {
      await promise;
      return false;
    } catch (error) {
      return error.code === "23514" && error.constraint === constraint;
    }
  };

  const base = {
    created_by: dan,
    paid_by: dan,
    description: "Rent",
    amount: 100,
    currency: "USD",
    exchange_rate: 1,
    split_type: "equal",
    splits: JSON.stringify([{ userId: dan, amount: 50, baseAmount: 50 }]),
    start_date: "2026-11-01",
    tz: "America/Toronto",
    frequency: "monthly",
  };
  const insertSchedule = (fields) => {
    const row = { ...base, ...fields };
    const cols = Object.keys(row);
    return db.query(
      `insert into public.recurring_schedules (${cols.join(", ")})
       values (${cols.map((_, i) => `$${i + 1}`).join(", ")}) returning id`,
      Object.values(row)
    );
  };
  const groupSchedule = async (gid = groupId) =>
    (await insertSchedule({ kind: "group", group_id: gid })).rows[0].id;
  const contactSchedule = async () =>
    (await insertSchedule({ kind: "contact", user_lo: lo, user_hi: hi, created_by: erin, paid_by: erin }))
      .rows[0].id;

  const gSched = await groupSchedule();
  const cSched = await contactSchedule();

  const { rows: cursor } = await db.query(
    `select next_index from public.recurring_schedules where id = $1`,
    [gSched]
  );
  check(cursor[0].next_index === 0, "a new schedule's next_index starts at 0");

  // Visibility.
  const visible = (uid) =>
    asUser(uid, async () => {
      const { rows } = await db.query(
        `select id from public.recurring_schedules where id = any($1::uuid[])`,
        [[gSched, cSched]]
      );
      return new Set(rows.map((r) => r.id));
    });
  const seenByDan = await visible(dan);
  check(
    seenByDan.has(gSched) && !seenByDan.has(cSched),
    "a group member sees the group's schedule and not a contact pair's they are not in"
  );
  const seenByErin = await visible(erin);
  check(
    seenByErin.has(gSched) && seenByErin.has(cSched),
    "a contact participant who is also a group member sees both schedules"
  );
  const seenByFay = await visible(fay);
  check(
    seenByFay.has(cSched) && !seenByFay.has(gSched),
    "the other contact participant sees the pair's schedule and not the group's"
  );
  check((await visible(gus)).size === 0, "an outsider sees no schedules");

  const { rows: policies } = await db.query(
    `select cmd from pg_policies where schemaname = 'public' and tablename = 'recurring_schedules'`
  );
  check(
    policies.length === 2 && policies.every((p) => p.cmd === "SELECT"),
    "recurring_schedules has two SELECT policies and no write policy"
  );

  const { rows: grants } = await db.query(`
    select c.relkind,
      has_table_privilege('authenticated', c.oid, 'SELECT') as can_read,
      has_table_privilege('anon', c.oid, 'SELECT') as anon_read
    from pg_class c where c.oid = 'public.recurring_schedules'::regclass
  `);
  check(
    grants[0].relkind === "r" && grants[0].can_read && grants[0].anon_read,
    "recurring_schedules is a public table with SELECT for clients (so the no-write-grant sweep covers it)"
  );
  check(
    await asUser(dan, () =>
      rejects(
        insertSchedule({ kind: "group", group_id: groupId }),
        "42501"
      )
    ),
    "a client cannot insert a schedule directly"
  );

  // Shape constraints.
  check(
    await violates(
      insertSchedule({ kind: "group", group_id: groupId, user_lo: lo, user_hi: hi }),
      "recurring_schedules_scope_check"
    ),
    "a schedule with both a group and a contact pair is rejected"
  );
  check(
    await violates(insertSchedule({ kind: "group" }), "recurring_schedules_scope_check"),
    "a schedule with neither a group nor a contact pair is rejected"
  );
  check(
    await violates(
      insertSchedule({ kind: "contact", group_id: groupId }),
      "recurring_schedules_scope_check"
    ),
    "a schedule whose kind disagrees with its scope is rejected"
  );
  check(
    await violates(
      insertSchedule({ kind: "contact", user_lo: hi, user_hi: lo }),
      "recurring_schedules_check"
    ),
    "a contact pair out of order (user_lo > user_hi) is rejected"
  );
  check(
    await violates(
      insertSchedule({ kind: "group", group_id: groupId, frequency: "hourly" }),
      "recurring_schedules_frequency_check"
    ),
    "frequency 'hourly' is rejected"
  );
  check(
    await violates(
      insertSchedule({ kind: "group", group_id: groupId, amount: 0 }),
      "recurring_schedules_amount_check"
    ),
    "a zero amount is rejected"
  );
  check(
    await violates(
      insertSchedule({ kind: "group", group_id: groupId, max_count: 0 }),
      "recurring_schedules_max_count_check"
    ),
    "max_count 0 is rejected"
  );

  const { rows: scanIndex } = await db.query(`
    select indexdef from pg_indexes
    where schemaname = 'public' and tablename = 'recurring_schedules'
      and indexdef ilike '%where (stopped_at is null)%'
  `);
  check(scanIndex.length === 1, "a partial index covers the cron scan of unstopped schedules");

  // Link columns and the one-expense-per-occurrence index, on both tables.
  const tables = [
    {
      table: "expenses",
      schedule: gSched,
      makeSchedule: () => groupSchedule(),
      insert: (scheduleId, occurrence) =>
        db.query(
          `insert into public.expenses (group_id, paid_by, amount, description, schedule_id, occurrence_date)
           values ($1, $2, 10, 'Rent', $3, $4) returning id`,
          [groupId, dan, scheduleId, occurrence]
        ),
    },
    {
      table: "contact_expenses",
      schedule: cSched,
      makeSchedule: () => contactSchedule(),
      insert: (scheduleId, occurrence) =>
        db.query(
          `insert into public.contact_expenses (paid_by, user_lo, user_hi, amount, description, schedule_id, occurrence_date)
           values ($1, $2, $3, 10, 'Rent', $4, $5) returning id`,
          [erin, lo, hi, scheduleId, occurrence]
        ),
    },
  ];
  for (const { table, schedule, makeSchedule, insert } of tables) {
    // Postgres treats nulls as distinct either way, so only the definition
    // shows the index is partial (the engine's ON CONFLICT names that predicate).
    const { rows: unique } = await db.query(
      `select 1 from pg_indexes where schemaname = 'public' and tablename = $1
         and indexdef ilike 'create unique index % (schedule_id, occurrence_date) where (schedule_id is not null)'`,
      [table]
    );
    check(
      unique.length === 1,
      `${table}: a partial unique index on (schedule_id, occurrence_date) where schedule_id is not null`
    );

    await insert(schedule, "2026-11-01");
    check(
      await rejects(insert(schedule, "2026-11-01"), "23505"),
      `${table}: a second row for the same (schedule_id, occurrence_date) is rejected`
    );
    check(
      !(await rejects(insert(schedule, "2026-12-01"))),
      `${table}: the same schedule on another date is allowed`
    );
    check(
      !(await rejects(
        (async () => {
          await insert(null, null);
          await insert(null, null);
          await insert(null, "2026-11-01");
          await insert(null, "2026-11-01");
        })()
      )),
      `${table}: many rows with no schedule_id are allowed`
    );

    const doomed = await makeSchedule();
    const { rows: linked } = await insert(doomed, "2026-11-01");
    await db.query(`delete from public.recurring_schedules where id = $1`, [doomed]);
    const { rows: after } = await db.query(
      `select schedule_id, occurrence_date from public.${table} where id = $1`,
      [linked[0].id]
    );
    check(
      after.length === 1 && after[0].schedule_id === null && after[0].occurrence_date !== null,
      `${table}: deleting a schedule keeps its expenses and clears their schedule_id`
    );
  }

  const otherGroup = await createGroup("Gym");
  const goneWithGroup = await groupSchedule(otherGroup);
  await db.query(`delete from public.groups where id = $1`, [otherGroup]);
  const { rows: survivors } = await db.query(
    `select id from public.recurring_schedules where id = $1`,
    [goneWithGroup]
  );
  check(survivors.length === 0, "deleting a group deletes its schedules");
}
