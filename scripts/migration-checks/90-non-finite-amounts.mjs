// NaN and +/-Infinity are refused in every money amount and exchange rate a
// client can send: the expense and payment RPCs (group and contact, create and
// update), each split's amount and baseAmount inside p_splits, and the
// recurring-schedule RPCs. Postgres says `NaN <= 0` is false (NaN sorts above
// every number), so a bare positivity check let NaN and Infinity through and
// get_group_balances then returned NaN. A refused call must store nothing, leave
// the balances finite, and use the field's existing message; ordinary decimals
// must keep working.

const NON_FINITE = ["NaN", "Infinity", "-Infinity"];
const NON_FINITE_IN_JSON = [...NON_FINITE, "nan", "inf", "-inf", "+Infinity"];

const AMOUNT_MESSAGE = "Expense amount must be greater than zero";
const RATE_MESSAGE = "Exchange rate must be greater than zero";
const SPLIT_MESSAGE = "Split amount must be a valid number";
const NEGATIVE_SPLIT_MESSAGE = "Split amount cannot be negative";
const PAYMENT_MESSAGE = "Payment amount must be greater than zero";

export default async function nonFiniteAmounts({ db, asUser, signUp, check }) {
  const amy = await signUp("nf-amy@example.com", "Amy");
  const ben = await signUp("nf-ben@example.com", "Ben");

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
  const json = (value) => JSON.stringify(value);
  const halves = (a, b) => json([{ userId: amy, amount: a }, { userId: ben, amount: b }]);

  const groupId = await asUser(amy, async () =>
    (await one(`select * from public.create_group_with_members($1, $2::text[], 'USD')`, [
      "Non-finite amounts",
      ["nf-ben@example.com"],
    ])).id
  );
  await asUser(amy, () => db.query(`select public.send_contact_request($1)`, ["nf-ben@example.com"]));
  await asUser(ben, async () => {
    const request = await one(
      `select id from public.get_contact_requests() where direction = 'incoming' and user_id = $1`,
      [amy]
    );
    await db.query(`select public.respond_contact_request($1, true)`, [request.id]);
  });

  const snapshot = async () =>
    (await one(
      `select jsonb_build_array(
         (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') from public.expenses t),
         (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') from public.expense_splits t),
         (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') from public.payments t),
         (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') from public.contact_expenses t),
         (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') from public.contact_expense_splits t),
         (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') from public.contact_payments t),
         (select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]') from public.recurring_schedules t)
       )::text as s`
    )).s;

  const balancesAreFinite = async () => {
    const group = await asUser(amy, () =>
      q(`select balance from public.get_group_balances($1)`, [groupId])
    );
    const contact = await asUser(amy, () =>
      one(`select public.get_contact_balance($1) as b`, [ben])
    );
    return [...group.map((r) => r.balance), contact.b].every((b) => Number.isFinite(Number(b)));
  };

  // Ordinary rows the update cases edit, made first so they prove the happy path.
  const groupExpense = await asUser(amy, async () =>
    (await one(
      `select * from public.create_expense_with_splits($1, $2, 12.34, 'Ordinary', null, 'exact',
         $3::jsonb, null, 'USD', 2)`,
      [groupId, amy, json([{ userId: amy, amount: 6.17 }, { userId: ben, amount: 6.17 }])]
    ))
  );
  const contactExpense = await asUser(amy, async () =>
    (await one(
      `select * from public.create_contact_expense_with_splits($1, $2, 12.34, 'Ordinary', null, 'exact',
         $3::jsonb, null, 'USD', 2)`,
      [ben, amy, json([{ userId: amy, amount: 6.17 }, { userId: ben, amount: 6.17 }])]
    ))
  );
  check(
    Number(groupExpense.amount) === 12.34 && Number(groupExpense.base_amount) === 24.68,
    "ordinary decimals: create_expense_with_splits stores 12.34 at rate 2 (base 24.68)"
  );
  check(
    Number(contactExpense.amount) === 12.34 && Number(contactExpense.base_amount) === 24.68,
    "ordinary decimals: create_contact_expense_with_splits stores 12.34 at rate 2 (base 24.68)"
  );
  const groupPayment = await asUser(amy, async () =>
    one(`select * from public.create_payment($1, $2, $3, 7.25)`, [groupId, amy, ben])
  );
  const contactPayment = await asUser(amy, async () =>
    one(`select * from public.create_contact_payment($1, $2, $3, 7.25)`, [ben, amy, ben])
  );
  check(Number(groupPayment.amount) === 7.25, "ordinary decimals: create_payment stores 7.25");
  check(Number(contactPayment.amount) === 7.25, "ordinary decimals: create_contact_payment stores 7.25");

  const expenseCalls = {
    create_expense_with_splits: (amount, splits, rate) =>
      db.query(
        `select * from public.create_expense_with_splits($1, $2, $3::numeric, 'Refused', null, 'exact',
           $4::jsonb, null, 'USD', $5::numeric)`,
        [groupId, amy, amount, splits, rate]
      ),
    update_expense_with_splits: (amount, splits, rate) =>
      db.query(
        `select * from public.update_expense_with_splits($1, $2, $3::numeric, 'Refused', null, 'exact',
           $4::jsonb, null, 'USD', $5::numeric)`,
        [groupExpense.id, amy, amount, splits, rate]
      ),
    create_contact_expense_with_splits: (amount, splits, rate) =>
      db.query(
        `select * from public.create_contact_expense_with_splits($1, $2, $3::numeric, 'Refused', null, 'exact',
           $4::jsonb, null, 'USD', $5::numeric)`,
        [ben, amy, amount, splits, rate]
      ),
    update_contact_expense_with_splits: (amount, splits, rate) =>
      db.query(
        `select * from public.update_contact_expense_with_splits($1, $2, $3::numeric, 'Refused', null,
           'exact', $4::jsonb, null, 'USD', $5::numeric)`,
        [contactExpense.id, amy, amount, splits, rate]
      ),
  };

  const refusedCleanly = async (label, expected, run) => {
    const before = await snapshot();
    const message = await asUser(amy, () => errorOf(run()));
    const unchanged = (await snapshot()) === before;
    check(message === expected, `${label}: refused with "${expected}" (got: ${message})`);
    check(unchanged, `${label}: stores and changes nothing`);
    check(await balancesAreFinite(), `${label}: balances stay finite`);
  };

  for (const [name, call] of Object.entries(expenseCalls)) {
    for (const value of NON_FINITE) {
      await refusedCleanly(`${name} amount ${value}`, AMOUNT_MESSAGE, () =>
        call(value, halves(5, 5), "1")
      );
      await refusedCleanly(`${name} exchange rate ${value}`, RATE_MESSAGE, () =>
        call("10", halves(5, 5), value)
      );
    }
    for (const value of NON_FINITE_IN_JSON) {
      await refusedCleanly(`${name} split amount '${value}'`, SPLIT_MESSAGE, () =>
        call("10", halves(value, 5), "1")
      );
      await refusedCleanly(`${name} second split amount '${value}'`, SPLIT_MESSAGE, () =>
        call("10", halves(5, value), "1")
      );
      await refusedCleanly(`${name} split baseAmount '${value}'`, SPLIT_MESSAGE, () =>
        call(
          "10",
          json([{ userId: amy, amount: 5, baseAmount: value }, { userId: ben, amount: 5 }]),
          "1"
        )
      );
    }

    // Messages and order for ordinary bad input are untouched.
    await refusedCleanly(`${name} amount 0`, AMOUNT_MESSAGE, () => call("0", halves(5, 5), "1"));
    await refusedCleanly(`${name} rate 0`, RATE_MESSAGE, () => call("10", halves(5, 5), "0"));
    await refusedCleanly(`${name} negative split`, NEGATIVE_SPLIT_MESSAGE, () =>
      call("10", halves(-1, 11), "1")
    );
    await refusedCleanly(`${name} NaN amount and NaN rate report the amount first`, AMOUNT_MESSAGE, () =>
      call("NaN", halves(5, 5), "NaN")
    );
    await refusedCleanly(`${name} NaN rate and NaN split report the rate first`, RATE_MESSAGE, () =>
      call("10", halves("NaN", 5), "NaN")
    );
  }

  const edited = await asUser(amy, async () =>
    one(`select * from public.update_expense_with_splits($1, $2, 12.34, 'Edited', null, 'exact',
           $3::jsonb, null, 'USD', 2)`, [
      groupExpense.id,
      amy,
      json([{ userId: amy, amount: 6.17 }, { userId: ben, amount: 6.17 }]),
    ])
  );
  check(edited.description === "Edited", "ordinary decimals: update_expense_with_splits still edits");
  const editedContact = await asUser(amy, async () =>
    one(`select * from public.update_contact_expense_with_splits($1, $2, 12.34, 'Edited', null, 'exact',
           $3::jsonb, null, 'USD', 2)`, [
      contactExpense.id,
      amy,
      json([{ userId: amy, amount: 6.17 }, { userId: ben, amount: 6.17 }]),
    ])
  );
  check(
    editedContact.description === "Edited",
    "ordinary decimals: update_contact_expense_with_splits still edits"
  );

  const paymentCalls = {
    create_payment: (amount) =>
      db.query(`select * from public.create_payment($1, $2, $3, $4::numeric)`, [groupId, amy, ben, amount]),
    update_payment: (amount) =>
      db.query(`select * from public.update_payment($1, $2, $3, $4::numeric)`, [
        groupPayment.id,
        amy,
        ben,
        amount,
      ]),
    create_contact_payment: (amount) =>
      db.query(`select * from public.create_contact_payment($1, $2, $3, $4::numeric)`, [
        ben,
        amy,
        ben,
        amount,
      ]),
    update_contact_payment: (amount) =>
      db.query(`select * from public.update_contact_payment($1, $2, $3, $4::numeric)`, [
        contactPayment.id,
        amy,
        ben,
        amount,
      ]),
  };
  for (const [name, call] of Object.entries(paymentCalls)) {
    for (const value of NON_FINITE) {
      await refusedCleanly(`${name} amount ${value}`, PAYMENT_MESSAGE, () => call(value));
    }
    await refusedCleanly(`${name} amount 0`, PAYMENT_MESSAGE, () => call("0"));
    await refusedCleanly(`${name} NULL amount`, PAYMENT_MESSAGE, () => call(null));
  }
  const paymentEdit = await asUser(amy, async () =>
    one(`select * from public.update_payment($1, $2, $3, 8.5)`, [groupPayment.id, amy, ben])
  );
  const contactPaymentEdit = await asUser(amy, async () =>
    one(`select * from public.update_contact_payment($1, $2, $3, 8.5)`, [contactPayment.id, amy, ben])
  );
  check(Number(paymentEdit.amount) === 8.5, "ordinary decimals: update_payment still edits");
  check(Number(contactPaymentEdit.amount) === 8.5, "ordinary decimals: update_contact_payment still edits");

  // The recurring RPCs already refuse these; pinned here so they stay that way.
  const today = (await one(`select to_char((now() at time zone 'UTC')::date, 'YYYY-MM-DD') as d`)).d;
  const createSchedule = (amount, splits, rate) =>
    db.query(
      `select * from public.create_recurring_schedule($1, null, $2, $3::numeric, 'Rent', null,
         'exact'::public.split_type, $4::jsonb, 'USD', $5::numeric, $6::date, 'UTC', 'monthly', null, null)`,
      [groupId, amy, amount, splits, rate, today]
    );
  for (const value of NON_FINITE) {
    await refusedCleanly(`create_recurring_schedule amount ${value}`, AMOUNT_MESSAGE, () =>
      createSchedule(value, halves(5, 5), "1")
    );
    await refusedCleanly(`create_recurring_schedule exchange rate ${value}`, RATE_MESSAGE, () =>
      createSchedule("10", halves(5, 5), value)
    );
    await refusedCleanly(
      `create_recurring_schedule split amount '${value}'`,
      "Each split needs a user and an amount",
      () => createSchedule("10", halves(value, 5), "1")
    );
  }
  const schedule = await asUser(amy, async () =>
    one(
      `select * from public.create_recurring_schedule($1, null, $2, 10, 'Rent', null,
         'exact'::public.split_type, $3::jsonb, 'USD', 1, $4::date, 'UTC', 'monthly', null, null)`,
      [groupId, amy, halves(5, 5), today]
    )
  );
  for (const value of NON_FINITE) {
    await refusedCleanly(`update_recurring_schedule amount ${value}`, "Expense amount must be a valid number", () =>
      db.query(`select * from public.update_recurring_schedule($1, $2::numeric, null, null, null, $3::jsonb)`, [
        schedule.id,
        value,
        halves(5, 5),
      ])
    );
    await refusedCleanly(`update_recurring_schedule split amount '${value}'`, "Split amount must be a valid number", () =>
      db.query(`select * from public.update_recurring_schedule($1, 10, null, null, null, $2::jsonb)`, [
        schedule.id,
        halves(value, 5),
      ])
    );
  }
}
