// The "no account" errors reach people word for word (the add-member and
// add-contact screens show the server message), so they must not carry the
// product name: the app has been renamed once already, and a name inside a SQL
// string would need a new migration for every rename.
export default async ({ db, asUser, signUp, check }) => {
  const owner = await signUp("owner-msg@example.com", "Owner");
  const message = async (sql, params) => {
    try {
      await asUser(owner, () => db.query(sql, params));
      return "(no error)";
    } catch (error) {
      return error.message;
    }
  };

  const created = await message(
    `select * from public.create_group_with_members('Msg', array['ghost@example.com'], 'USD')`
  );
  check(
    created === "No account found for: ghost@example.com",
    `create_group_with_members says "No account found for: ..." (got: ${created})`
  );

  const groupId = await asUser(owner, async () => {
    const { rows } = await db.query(
      `select * from public.create_group_with_members('Msg2', '{}', 'USD')`
    );
    return rows[0].id;
  });
  const added = await message(
    `select public.add_group_members($1, array['ghost@example.com'])`,
    [groupId]
  );
  check(
    added === "No account found for: ghost@example.com",
    `add_group_members says "No account found for: ..." (got: ${added})`
  );

  const requested = await message(
    `select public.send_contact_request('ghost@example.com')`
  );
  check(
    requested === "No account found for ghost@example.com",
    `send_contact_request says "No account found for ..." (got: ${requested})`
  );

  // No function in the public schema may carry a product name in its body (its
  // messages, comments or anything else), so the next rename needs no migration.
  const named = (
    await db.query(
      `select p.proname
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.prokind = 'f'
         and p.prosrc ~* '(evenpot|splitbill|splitfox|split bill)'
       order by 1`
    )
  ).rows.map((row) => row.proname);
  check(
    named.length === 0,
    `no function body in public names the product (found in: ${named.join(", ") || "none"})`
  );
};
