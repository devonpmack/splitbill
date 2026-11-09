// Payment dates: payments and contact_payments carry a `date`, and the four
// payment RPCs take a trailing p_date (create: null means now(); update: null
// keeps the stored date).
const RPCS = [
  "create_payment",
  "update_payment",
  "create_contact_payment",
  "update_contact_payment",
];

const FUTURE = "2030-01-15T05:00:00+00:00";
const LATER = "2031-06-01T04:00:00+00:00";

const sameInstant = (a, b) => new Date(a).getTime() === new Date(b).getTime();

const errorOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error.message;
  }
};

export default async ({ db, asUser, signUp, check }) => {
  for (const table of ["payments", "contact_payments"]) {
    const { rows } = await db.query(
      `select column_name, data_type, is_nullable, column_default,
         ordinal_position = (select max(ordinal_position) from information_schema.columns
           where table_schema = 'public' and table_name = $1) as is_last
       from information_schema.columns
       where table_schema = 'public' and table_name = $1 and column_name = 'date'`,
      [table]
    );
    const col = rows[0];
    check(
      col &&
        col.data_type === "timestamp with time zone" &&
        col.is_nullable === "NO" &&
        col.column_default === "now()" &&
        col.is_last,
      `${table}.date is the last column, timestamptz not null default now()`
    );
  }

  const procs = await db.query(
    `select p.proname, count(*)::int as n,
       max(pg_get_function_identity_arguments(p.oid)) as args
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace and p.proname = any($1)
     group by p.proname`,
    [RPCS]
  );
  for (const name of RPCS) {
    const row = procs.rows.find((r) => r.proname === name);
    check(
      row && row.n === 1 && row.args.endsWith("p_date timestamp with time zone"),
      `exactly one ${name}, with p_date as its last parameter`
    );
  }

  // Dropping and re-creating a function resets its ACL to the defaults; the
  // payment RPCs must end with the same grants as an untouched RPC.
  const acls = await db.query(
    `select p.proname, coalesce(p.proacl::text, '') as acl,
       has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname = any($1)`,
    [[...RPCS, "delete_payment"]]
  );
  const reference = acls.rows.find((r) => r.proname === "delete_payment");
  for (const name of RPCS) {
    const row = acls.rows.find((r) => r.proname === name);
    check(
      row &&
        row.acl === reference.acl &&
        row.auth_exec === reference.auth_exec &&
        row.anon_exec === reference.anon_exec &&
        row.auth_exec,
      `${name} keeps the same grants as delete_payment (authenticated may execute)`
    );
  }

  const dave = await signUp("dave.dates@example.com", "Dave");
  const erin = await signUp("erin.dates@example.com", "Erin");
  const frank = await signUp("frank.dates@example.com", "Frank");
  await db.query(`select public.create_contact_pair($1, $2)`, [dave, erin]);
  const groupId = await asUser(dave, async () => {
    const { rows } = await db.query(
      `select * from public.create_group_with_members('Dates', array['erin.dates@example.com'], 'USD')`
    );
    return rows[0].id;
  });

  // anon reaches the RPCs exactly as before (same grants) and is turned away by
  // the auth.uid() check.
  await db.exec(`set role anon`);
  try {
    check(
      (await errorOf(
        db.query(`select public.create_payment($1, $2, $3, 5, null, null, $4)`, [
          groupId,
          dave,
          erin,
          FUTURE,
        ])
      )) === "Not authenticated",
      "anon cannot record a payment with p_date (Not authenticated)"
    );
    check(
      (await errorOf(
        db.query(`select public.create_contact_payment($1, $2, $3, 5, null, null, $4)`, [
          erin,
          dave,
          erin,
          FUTURE,
        ])
      )) === "Not authenticated",
      "anon cannot record a contact payment with p_date (Not authenticated)"
    );
  } finally {
    await db.exec(`reset role`);
  }

  const kinds = [
    {
      label: "payment",
      table: "payments",
      strangerError: "You can only edit payments you are part of",
      create: (date) =>
        db.query(
          `select * from public.create_payment($1, $2, $3, 10, 'p', null, $4)`,
          [groupId, dave, erin, date]
        ),
      createOld: () =>
        db.query(`select * from public.create_payment($1, $2, $3, 10, 'old')`, [
          groupId,
          dave,
          erin,
        ]),
      update: (id, note, date) =>
        db.query(`select * from public.update_payment($1, $2, $3, 12, $4, $5)`, [
          id,
          dave,
          erin,
          note,
          date,
        ]),
      updateOld: (id) =>
        db.query(`select * from public.update_payment($1, $2, $3, 13, 'old shape')`, [
          id,
          dave,
          erin,
        ]),
      rawInsert: () =>
        db.query(
          `insert into public.payments (group_id, paid_by, paid_to, amount, currency, exchange_rate, base_amount)
           values ($1, $2, $3, 1, 'USD', 1, 1) returning date, created_at`,
          [groupId, dave, erin]
        ),
    },
    {
      label: "contact payment",
      table: "contact_payments",
      strangerError: "You are not a participant in this payment",
      create: (date) =>
        db.query(
          `select * from public.create_contact_payment($1, $2, $3, 10, 'p', null, $4)`,
          [erin, dave, erin, date]
        ),
      createOld: () =>
        db.query(`select * from public.create_contact_payment($1, $2, $3, 10, 'old')`, [
          erin,
          dave,
          erin,
        ]),
      update: (id, note, date) =>
        db.query(
          `select * from public.update_contact_payment($1, $2, $3, 12, $4, $5)`,
          [id, dave, erin, note, date]
        ),
      updateOld: (id) =>
        db.query(
          `select * from public.update_contact_payment($1, $2, $3, 13, 'old shape')`,
          [id, dave, erin]
        ),
      rawInsert: () =>
        db.query(
          `insert into public.contact_payments (paid_by, paid_to, user_lo, user_hi, amount, currency, exchange_rate, base_amount)
           values ($1::uuid, $2::uuid, least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), 1, 'USD', 1, 1)
           returning date, created_at`,
          [dave, erin]
        ),
    },
  ];

  for (const kind of kinds) {
    const future = await asUser(dave, () => kind.create(FUTURE));
    const futureRow = future.rows[0];
    check(
      sameInstant(futureRow.date, FUTURE),
      `a ${kind.label} created with a future p_date stores that date`
    );

    const now = await asUser(dave, () => kind.create(null));
    const { rows: clock } = await db.query(`select now() as now`);
    check(
      Math.abs(new Date(now.rows[0].date) - new Date(clock[0].now)) < 60_000,
      `a ${kind.label} created with a null p_date is dated now`
    );

    const old = await asUser(dave, () => kind.createOld());
    check(
      old.rows.length === 1 && Math.abs(new Date(old.rows[0].date) - new Date(clock[0].now)) < 60_000,
      `the old ${kind.label} create call (no p_date) still works and is dated now`
    );

    const kept = await asUser(erin, () => kind.update(futureRow.id, "edited note", null));
    check(
      sameInstant(kept.rows[0].date, FUTURE) && kept.rows[0].note === "edited note",
      `updating a ${kind.label} with a null p_date keeps its date`
    );

    const moved = await asUser(erin, () => kind.update(futureRow.id, "moved", LATER));
    check(
      sameInstant(moved.rows[0].date, LATER),
      `updating a ${kind.label} with a new p_date changes its date`
    );

    const oldUpdate = await asUser(dave, () => kind.updateOld(futureRow.id));
    check(
      sameInstant(oldUpdate.rows[0].date, LATER) && Number(oldUpdate.rows[0].amount) === 13,
      `the old ${kind.label} update call (no p_date) still works and keeps the date`
    );

    check(
      (await asUser(frank, () => errorOf(kind.update(futureRow.id, "x", LATER)))) ===
        kind.strangerError,
      `a stranger still cannot update a ${kind.label} when passing p_date`
    );

    const raw = await kind.rawInsert();
    check(
      raw.rows[0].date !== null && sameInstant(raw.rows[0].date, raw.rows[0].created_at),
      `a ${kind.label} row inserted with only the old columns gets a default date`
    );

    const { rows: nulls } = await db.query(
      `select count(*)::int as n from public.${kind.table} where date is null`
    );
    check(nulls[0].n === 0, `no ${kind.table} row has a null date`);
  }

  check(
    (await asUser(dave, () =>
      errorOf(
        db.query(`select public.create_payment($1, $2, $3, 0, null, null, $4)`, [
          groupId,
          dave,
          erin,
          FUTURE,
        ])
      )
    )) === "Payment amount must be greater than zero",
    "create_payment with p_date still refuses a zero amount with the same message"
  );
  check(
    (await asUser(dave, () =>
      errorOf(
        db.query(`select public.create_contact_payment($1, $2, $3, 5, null, 'EUR', $4)`, [
          erin,
          dave,
          erin,
          FUTURE,
        ])
      )
    )) === "Payments must be recorded in the contact currency (USD)",
    "create_contact_payment with p_date still refuses a foreign currency with the same message"
  );
};
