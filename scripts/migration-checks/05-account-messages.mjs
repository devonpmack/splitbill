// The "no account" errors reach people word for word (the add-contact screen
// shows the server message), so they must name the app as Evenpot.
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
    created === "No Evenpot account found for: ghost@example.com",
    `create_group_with_members names Evenpot (got: ${created})`
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
    added === "No Evenpot account found for: ghost@example.com",
    `add_group_members names Evenpot (got: ${added})`
  );

  const requested = await message(
    `select public.send_contact_request('ghost@example.com')`
  );
  check(
    requested === "No Evenpot account found for ghost@example.com",
    `send_contact_request names Evenpot (got: ${requested})`
  );
};
