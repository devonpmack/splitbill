// get_contacts_with_combined_balances returns contact_deleted_at (the last column):
// the contact's profiles.deleted_at. The client needs it to stop offering a deleted
// contact in new 1-on-1 expenses, which the server refuses.

export default async function contactsDeletedFlag({ db, asUser, signUp, check }) {
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];
  const json = (value) => JSON.stringify(value);
  const errorOf = async (promise) => {
    try {
      await promise;
      return null;
    } catch (error) {
      return error.message;
    }
  };

  const amy = await signUp("cdf-amy@example.com", "Amy");
  const ben = await signUp("cdf-ben@example.com", "Ben");
  const cat = await signUp("cdf-cat@example.com", "Cat");

  await asUser(amy, () => db.query(`select public.send_contact_request($1)`, ["cdf-ben@example.com"]));
  await asUser(ben, async () => {
    const request = await one(
      `select id from public.get_contact_requests() where direction = 'incoming' and user_id = $1`,
      [amy]
    );
    await db.query(`select public.respond_contact_request($1, true)`, [request.id]);
  });
  await asUser(amy, () => db.query(`select public.send_contact_request($1)`, ["cdf-cat@example.com"]));
  await asUser(cat, async () => {
    const request = await one(
      `select id from public.get_contact_requests() where direction = 'incoming' and user_id = $1`,
      [amy]
    );
    await db.query(`select public.respond_contact_request($1, true)`, [request.id]);
  });
  await asUser(amy, () =>
    one(
      `select * from public.create_contact_expense_with_splits($1, $2, 8, 'Lunch', null, 'exact', $3::jsonb)`,
      [ben, amy, json([{ userId: amy, amount: 4 }, { userId: ben, amount: 4 }])]
    )
  );
  await asUser(amy, () =>
    one(
      `select * from public.create_contact_expense_with_splits($1, $2, 6, 'Coffee', null, 'exact', $3::jsonb)`,
      [cat, amy, json([{ userId: amy, amount: 3 }, { userId: cat, amount: 3 }])]
    )
  );

  const functions = await q(
    `select pg_get_function_result(p.oid) as result from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'get_contacts_with_combined_balances'`
  );
  check(functions.length === 1, "exactly one get_contacts_with_combined_balances exists (no leftover overload)");
  check(
    /is_accepted boolean, contact_deleted_at timestamp with time zone\)$/.test(functions[0].result),
    "contact_deleted_at is the last column, after is_accepted"
  );

  const rows = () =>
    asUser(amy, () =>
      q(`select contact_user_id, contact_deleted_at from public.get_contacts_with_combined_balances()`)
    );
  const before = await rows();
  check(
    before.length >= 2 && before.every((r) => r.contact_deleted_at === null),
    "no contact is flagged while nobody has deleted their account"
  );

  await db.query(
    `update public.profiles set deleted_at = now(), full_name = 'Deleted user', avatar_url = null where id = $1`,
    [ben]
  );
  const after = await rows();
  const benRows = after.filter((r) => r.contact_user_id === ben);
  const catRows = after.filter((r) => r.contact_user_id === cat);
  check(
    benRows.length >= 1 && benRows.every((r) => r.contact_deleted_at !== null),
    "a contact whose profile is a tombstone comes back with contact_deleted_at set"
  );
  check(
    catRows.length >= 1 && catRows.every((r) => r.contact_deleted_at === null),
    "other contacts are unaffected (contact_deleted_at stays null)"
  );
  const names = await asUser(amy, () =>
    q(`select full_name from public.get_contacts_with_combined_balances() where contact_user_id = $1`, [ben])
  );
  check(names.length >= 1 && names.every((r) => r.full_name === "Deleted user"), "the ghost contact is still listed by its 'Deleted user' name");

  const acl = await one(
    `select has_function_privilege('authenticated', 'public.get_contacts_with_combined_balances()', 'execute') as authenticated,
            has_function_privilege('anon', 'public.get_contacts_with_combined_balances()', 'execute') as anon`
  );
  check(acl.authenticated === true && acl.anon === true, "execute grants are as before (default grants kept after the drop)");
  const anonError = await errorOf(db.query(`select * from public.get_contacts_with_combined_balances()`));
  check(anonError === null || /Not authenticated/.test(anonError), "a call without a user raises 'Not authenticated' or returns nothing, as before");
}
