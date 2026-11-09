One `.mjs` file per feature, run by `scripts/check-migrations.mjs` after its smoke
test, in filename order. Export a default `async ({ db, asUser, signUp, rejects,
check, pass, fail }) => {}`; optionally export `realtimeTables` (tables the
feature's migration adds to the `supabase_realtime` publication). `asUser(uid,
fn)` runs as the `authenticated` role with that uid; plain `db.query` runs as the
database owner. Name files so they sort after the checks they build on.
