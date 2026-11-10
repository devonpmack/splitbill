// Account deletion anonymises instead of cascading (piece 1: structure only).
// profiles.id used to reference auth.users ON DELETE CASCADE, so removing an auth
// user deleted the profile and, through the cascading foreign keys, every group
// they created and every expense, split, payment and contact they took part in.
// Now a profile outlives its auth.users row, and profiles.deleted_at marks a
// tombstone. Clients can read the column but never write it.

export default async function accountTombstone({ db, asUser, signUp, rejects, check }) {
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
  const asAnon = async (fn) => {
    await db.exec(`set role anon`);
    try {
      return await fn();
    } finally {
      await db.exec(`reset role`);
    }
  };

  const amy = await signUp("tomb-amy@example.com", "Amy");
  const ben = await signUp("tomb-ben@example.com", "Ben");

  const column = await one(
    `select data_type, is_nullable, column_default,
            ordinal_position = (select max(ordinal_position) from information_schema.columns
                                where table_schema = 'public' and table_name = 'profiles') as is_last
       from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'deleted_at'`
  );
  check(
    column?.data_type === "timestamp with time zone" && column.is_nullable === "YES" && column.column_default === null,
    "profiles.deleted_at exists as a nullable timestamptz with no default"
  );
  check(column?.is_last === true, "profiles.deleted_at is the last column of profiles");
  check(
    (await q(`select deleted_at from public.profiles where id in ($1, $2)`, [amy, ben])).every(
      (row) => row.deleted_at === null
    ),
    "a normal sign-up creates a profile with deleted_at null"
  );

  const fkToAuthUsers = await q(
    `select conname from pg_constraint
      where conrelid = 'public.profiles'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass`
  );
  check(fkToAuthUsers.length === 0, "there is no foreign key from profiles to auth.users");

  const groupId = await asUser(amy, async () =>
    (await one(`select * from public.create_group_with_members($1, $2::text[], 'USD')`, [
      "Tombstone trip",
      ["tomb-ben@example.com"],
    ])).id
  );
  const amyExpense = await asUser(amy, () =>
    one(
      `select * from public.create_expense_with_splits($1, $2, 20, 'Amy paid', null, 'exact', $3::jsonb)`,
      [groupId, amy, json([{ userId: amy, amount: 10 }, { userId: ben, amount: 10 }])]
    )
  );
  const benExpense = await asUser(ben, () =>
    one(
      `select * from public.create_expense_with_splits($1, $2, 30, 'Ben paid', null, 'exact', $3::jsonb)`,
      [groupId, ben, json([{ userId: amy, amount: 12 }, { userId: ben, amount: 18 }])]
    )
  );
  const payment = await asUser(amy, () =>
    one(`select * from public.create_payment($1, $2, $3, 5)`, [groupId, amy, ben])
  );
  await asUser(amy, () => db.query(`select public.send_contact_request($1)`, ["tomb-ben@example.com"]));
  await asUser(ben, async () => {
    const request = await one(
      `select id from public.get_contact_requests() where direction = 'incoming' and user_id = $1`,
      [amy]
    );
    await db.query(`select public.respond_contact_request($1, true)`, [request.id]);
  });
  const contactExpense = await asUser(amy, () =>
    one(
      `select * from public.create_contact_expense_with_splits($1, $2, 8, 'Contact lunch', null, 'exact', $3::jsonb)`,
      [ben, amy, json([{ userId: amy, amount: 4 }, { userId: ben, amount: 4 }])]
    )
  );
  const contactPayment = await asUser(amy, () =>
    one(`select * from public.create_contact_payment($1, $2, $3, 2)`, [ben, amy, ben])
  );

  const groupBalances = () =>
    asUser(ben, async () => {
      try {
        return await q(`select user_id, balance from public.get_group_balances($1) order by user_id`, [groupId]);
      } catch (error) {
        return { error: error.message };
      }
    });
  const balancesBefore = await groupBalances();
  check(
    Array.isArray(balancesBefore) && balancesBefore.length === 2,
    "before deletion get_group_balances lists both members"
  );

  await db.query(`delete from auth.users where id = $1`, [amy]);

  const exists = async (sql, params) => Number((await one(sql, params)).n) === 1;
  check(await exists(`select count(*) n from public.profiles where id = $1`, [amy]), "deleting the auth user keeps the profile");
  check(
    await exists(`select count(*) n from public.groups where id = $1 and created_by = $2`, [groupId, amy]),
    "deleting the auth user keeps the group they created"
  );
  check(
    await exists(`select count(*) n from public.group_members where group_id = $1 and user_id = $2`, [groupId, amy]),
    "deleting the auth user keeps their group membership"
  );
  check(
    await exists(`select count(*) n from public.expenses where id = $1 and paid_by = $2`, [amyExpense.id, amy]),
    "deleting the auth user keeps the expense they paid"
  );
  check(
    await exists(
      `select count(*) n from public.expense_splits where expense_id = $1 and user_id = $2`,
      [amyExpense.id, amy]
    ),
    "deleting the auth user keeps the splits on the expense they paid"
  );
  check(
    await exists(`select count(*) n from public.expenses where id = $1`, [benExpense.id]),
    "deleting the auth user keeps the expense someone else paid"
  );
  check(
    await exists(
      `select count(*) n from public.expense_splits where expense_id = $1 and user_id = $2`,
      [benExpense.id, amy]
    ),
    "deleting the auth user keeps their split on another member's expense"
  );
  check(
    await exists(`select count(*) n from public.payments where id = $1 and paid_by = $2`, [payment.id, amy]),
    "deleting the auth user keeps the payment they made"
  );
  check(
    await exists(
      `select count(*) n from public.contacts where owner_id = $1 and contact_user_id = $2`,
      [ben, amy]
    ) &&
      (await exists(
        `select count(*) n from public.contacts where owner_id = $1 and contact_user_id = $2`,
        [amy, ben]
      )),
    "deleting the auth user keeps the contact rows on both sides"
  );
  check(
    await exists(`select count(*) n from public.contact_expenses where id = $1`, [contactExpense.id]),
    "deleting the auth user keeps the 1:1 expense they paid"
  );
  check(
    await exists(
      `select count(*) n from public.contact_expense_splits where expense_id = $1 and user_id = $2`,
      [contactExpense.id, amy]
    ),
    "deleting the auth user keeps their split on the 1:1 expense"
  );
  check(
    await exists(`select count(*) n from public.contact_payments where id = $1`, [contactPayment.id]),
    "deleting the auth user keeps the 1:1 payment"
  );
  check(
    json(await groupBalances()) === json(balancesBefore),
    "the other member's get_group_balances is identical before and after the delete"
  );

  // The raw delete above already tombstoned her (on_auth_user_deleted, piece 3); a tombstone cannot be updated again.
  await db.query(`update public.profiles set deleted_at = now(), full_name = 'Deleted user' where id = $1 and deleted_at is null`, [amy]);
  const afterTombstone = await groupBalances();
  const ghost = Array.isArray(afterTombstone) ? afterTombstone.find((row) => row.user_id === amy) : null;
  check(
    ghost !== undefined && ghost !== null && Array.isArray(afterTombstone) && afterTombstone.length === 2,
    "get_group_balances still returns a tombstone profile that is a ghost member"
  );
  check(
    json(afterTombstone) === json(balancesBefore),
    "tombstoning the profile leaves the other member's group balances unchanged"
  );
  const shownName = await asUser(ben, () =>
    one(`select full_name from public.get_group_balances($1) where user_id = $2`, [groupId, amy])
  );
  check(shownName?.full_name === "Deleted user", "the ghost member shows under the tombstone name");

  const newcomer = await signUp("tomb-newcomer@example.com", "Newcomer");
  check(
    (await one(`select deleted_at from public.profiles where id = $1`, [newcomer])).deleted_at === null,
    "a sign-up after a deletion still creates a live profile"
  );

  check(
    await rejects(
      asUser(ben, () => db.query(`update public.profiles set deleted_at = now() where id = $1`, [ben])),
      "42501"
    ),
    "an authenticated client cannot set deleted_at, even on their own profile"
  );
  check(
    await rejects(
      asUser(ben, () => db.query(`update public.profiles set deleted_at = null where id = $1`, [amy])),
      "42501"
    ),
    "an authenticated client cannot clear deleted_at on a tombstone"
  );
  check(
    await rejects(asAnon(() => db.query(`update public.profiles set deleted_at = now() where id = $1`, [ben])), "42501"),
    "anon cannot set deleted_at"
  );
  check(
    (await one(`select deleted_at from public.profiles where id = $1`, [ben])).deleted_at === null &&
      (await one(`select deleted_at from public.profiles where id = $1`, [amy])).deleted_at !== null,
    "the refused updates changed nothing"
  );
  const grants = await one(
    `select has_table_privilege('authenticated', 'public.profiles', 'insert')
         or has_table_privilege('authenticated', 'public.profiles', 'update')
         or has_table_privilege('authenticated', 'public.profiles', 'delete')
         or has_table_privilege('anon', 'public.profiles', 'insert')
         or has_table_privilege('anon', 'public.profiles', 'update')
         or has_table_privilege('anon', 'public.profiles', 'delete')
         or has_column_privilege('authenticated', 'public.profiles', 'deleted_at', 'update')
         or has_column_privilege('anon', 'public.profiles', 'deleted_at', 'update') as writable,
       has_column_privilege('authenticated', 'public.profiles', 'deleted_at', 'select') as readable`
  );
  check(grants.writable === false && grants.readable === true, "clients hold SELECT and no write privilege on profiles.deleted_at");
  const writePolicies = await q(
    `select policyname from pg_policies where schemaname = 'public' and tablename = 'profiles' and cmd <> 'SELECT'`
  );
  check(writePolicies.length === 0, "profiles has no write policy for clients");
}
