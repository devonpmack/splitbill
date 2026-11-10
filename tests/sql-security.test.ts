import { readFileSync } from "fs";
import { join } from "path";

const migrationPath = (fileName: string) =>
  join(process.cwd(), "supabase", "migrations", fileName);

const readMigration = (fileName: string) =>
  readFileSync(migrationPath(fileName), "utf8");

const schemaPath = (fileName: string) =>
  join(process.cwd(), "supabase", "schemas", fileName);

const readSchema = (fileName: string) =>
  readFileSync(schemaPath(fileName), "utf8");

const functionBody = (sql: string, functionName: string) => {
  const match = sql.match(
    new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${functionName}\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`,
      "i"
    )
  );
  if (!match) {
    throw new Error(`Missing ${functionName} function definition`);
  }
  return match[1];
};

describe("SQL security guards", () => {
  it("keeps fresh installs from exposing balances through SECURITY DEFINER RPCs", () => {
    const fullSetup = readMigration("000_full_setup.sql");

    expect(functionBody(fullSetup, "get_group_balances")).toMatch(
      /IF NOT public\.is_group_member\(p_group_id,\s*auth\.uid\(\)\) THEN/i
    );
    expect(functionBody(fullSetup, "get_user_total_balance")).toMatch(
      /p_user_id <> auth\.uid\(\)/i
    );
  });

  it("keeps the declarative schema source guarding balance RPCs", () => {
    const functions = readSchema("04_functions.sql");

    expect(functionBody(functions, "get_group_balances")).toMatch(
      /IF NOT public\.is_group_member\(p_group_id,\s*auth\.uid\(\)\) THEN/i
    );
    expect(functionBody(functions, "get_user_total_balance")).toMatch(
      /p_user_id <> auth\.uid\(\)/i
    );
  });

  it("only returns the caller's own contacts from the combined-balance RPC", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_contacts_with_combined_balances");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/c\.owner_id = v_uid/i);
  });

  it("includes group-mates in the combined-balance list but keeps it caller-scoped", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_contacts_with_combined_balances");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/c\.owner_id = v_uid/i);
    expect(body).toMatch(/join public\.group_members gm2/i);
    expect(body).toMatch(/cr\.is_accepted or abs\(ctx\.balance\) > 0\.005/i);
  });

  it("scopes the per-group contact breakdown to the authenticated caller", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_contact_group_breakdown");

    expect(body).toMatch(/v_uid uuid := auth\.uid\(\)/i);
    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    // shared_groups intersects the caller's memberships with the contact's,
    // so only groups the caller belongs to can ever appear.
    expect(body).toMatch(/where gm\.user_id = v_uid/i);
  });

  it("routes the contact group breakdown through simplified edges when enabled", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_contact_group_breakdown");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/where gm\.user_id = v_uid/i);
    expect(body).toMatch(/get_group_simplified_edges\(sg\.gid\)/i);
    expect(body).toMatch(/where sg\.simplify_debts/i);
    expect(body).toMatch(/where .*not simplify_debts/i);
  });

  it("guards the simplified-edges RPC and uses a deterministic order", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_group_simplified_edges");

    expect(body).toMatch(/v_uid uuid := auth\.uid\(\)/i);
    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(
      /IF NOT public\.is_group_member\(p_group_id,\s*v_uid\) THEN/i
    );
    expect(body).toMatch(/order by b\.balance asc, b\.user_id asc/i);
    expect(body).toMatch(/order by b\.balance desc, b\.user_id asc/i);
    // The transfer is rounded once before being emitted AND subtracted, so the
    // emitted edge and the running remainders can't drift by a sub-cent residual.
    expect(body).toMatch(/v_transfer := round\(least\(/i);
    expect(body).toMatch(/amount := v_transfer;/i);
  });

  it("applies the involvement filter before the row cap in the activity RPC", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_recent_activity");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/public\.is_group_member\(e\.group_id, v_uid\)/i);
    expect(body).toMatch(/e\.paid_by = v_uid/i);
    expect(body).toMatch(/es\.user_id = v_uid/i);
    // The limit must come after the where clause, not before it.
    expect(body.indexOf("limit greatest")).toBeGreaterThan(
      body.indexOf("es.user_id = v_uid")
    );
  });

  it("splits the activity feed from upcoming expenses under the same guards", () => {
    const functions = readSchema("04_functions.sql");
    const recent = functionBody(functions, "get_recent_activity");
    const upcoming = functionBody(functions, "get_upcoming_expenses");

    expect(recent).toMatch(/and e\.date <= now\(\)/i);
    expect(upcoming).toMatch(/raise exception 'Not authenticated'/i);
    expect(upcoming).toMatch(/public\.is_group_member\(e\.group_id, v_uid\)/i);
    expect(upcoming).toMatch(/and e\.date > now\(\)/i);
    expect(upcoming).toMatch(/e\.paid_by = v_uid/i);
    expect(upcoming).toMatch(/es\.user_id = v_uid\s+and es\.amount > 0/i);
    expect(upcoming).toMatch(/order by e\.date asc/i);
    expect(upcoming.indexOf("limit greatest")).toBeGreaterThan(
      upcoming.indexOf("es.user_id = v_uid")
    );
    expect(functions).toMatch(
      /function public\.get_upcoming_expenses\([^)]*\)[\s\S]*?security definer\s+set search_path = public, pg_temp/i
    );
    // Same execute grants as get_recent_activity: neither is revoked or
    // granted explicitly, both keep the defaults.
    expect(functions).not.toMatch(/(grant|revoke)[^;]*get_(upcoming_expenses|recent_activity)/i);
  });

  it("pins search_path on every SECURITY DEFINER function", () => {
    const functions = readSchema("04_functions.sql");
    const lines = functions.split("\n");
    const unpinned: string[] = [];

    lines.forEach((line, i) => {
      if (line.trim() !== "security definer") return;
      // The clause may sit after a volatility marker (e.g. `stable`).
      const following = lines.slice(i + 1, i + 4).map((l) => l.trim());
      if (following.some((l) => l.startsWith("set search_path"))) return;
      const declaration = lines
        .slice(Math.max(0, i - 15), i)
        .reverse()
        .find((l) => l.includes("create or replace function"));
      unpinned.push(declaration ?? `line ${i + 1}`);
    });

    expect(unpinned).toEqual([]);
  });

  it("blocks leaving a group with an outstanding balance server-side", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "leave_group");

    expect(body).toMatch(/from public\.get_group_balances\(p_group_id\)/i);
    expect(body).toMatch(/abs\(coalesce\(v_balance, 0\)\) >= 0\.01/i);
    expect(body).toMatch(
      /raise exception 'Settle your outstanding balance before leaving this group'/i
    );
  });

  it("lets either participant delete a one-on-one expense", () => {
    // The update RPC already allows either participant, and group expenses are
    // member-deletable, so a payer-only delete made the non-payer's trash
    // button a silent no-op.
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "delete_contact_expense");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/v_uid <> v_lo and v_uid <> v_hi/i);
    expect(body).toMatch(/You are not a participant in this expense/i);
  });

  it("guards the send-contact-request RPC", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "send_contact_request");

    expect(body).toMatch(/v_uid uuid := auth\.uid\(\)/i);
    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    // Takes an email and resolves it server-side, so the client never handles
    // a user id for an address it just typed.
    expect(body).toMatch(/lower\(au\.email\) = v_email/i);
    expect(body).toMatch(/No account found for/i);
    // Cannot request yourself, and cannot duplicate an existing contact.
    expect(body).toMatch(/v_recipient = v_uid/i);
    expect(body).toMatch(
      /owner_id = v_uid and contact_user_id = v_recipient/i
    );
  });

  it("restricts responding to requests addressed to the caller", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "respond_contact_request");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/v_request\.recipient_id <> v_uid/i);
  });

  it("restricts cancelling to requests sent by the caller", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "cancel_contact_request");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/v_request\.requester_id <> v_uid/i);
  });

  it("scopes the contact-requests listing to the caller", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_contact_requests");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/cr\.requester_id = v_uid or cr\.recipient_id = v_uid/i);
  });

  it("gates one-on-one expense creation on an accepted contact", () => {
    const functions = readSchema("04_functions.sql");
    const helper = functionBody(functions, "_insert_contact_expense");
    const wrapper = functionBody(functions, "create_contact_expense_with_splits");

    expect(helper).toMatch(/You can only add expenses with accepted contacts/i);
    expect(helper).toMatch(/owner_id = p_actor and contact_user_id = p_contact_user_id/i);
    // The public RPC supplies the signed-in user as the actor, never a parameter.
    expect(wrapper).toMatch(/raise exception 'Not authenticated'/i);
    expect(wrapper).toMatch(/_insert_contact_expense\(\s*v_uid,/i);
  });

  it("revokes client execute on every private (underscore) function", () => {
    const functions = readSchema("04_functions.sql");
    const names = [
      ...functions.matchAll(/create or replace function public\.(_\w+)\(/gi),
    ].map((match) => match[1]);

    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(functions).toMatch(
        new RegExp(
          `revoke execute on function public\\.${name}\\([^;]*from public, anon, authenticated;`,
          "i"
        )
      );
    }
  });

  it("keeps account deletion to one code path and admin deletion to service_role", () => {
    const functions = readSchema("04_functions.sql");
    const migration = readMigration("20261109211000_admin_delete_account.sql");

    // admin_delete_account is the one function outside the `_` rule that clients must
    // not execute: it is meant to be called, by service_role only.
    for (const sql of [functions, migration]) {
      expect(sql).toMatch(
        /revoke execute on function public\.admin_delete_account\(uuid\) from public, anon, authenticated;/i
      );
      expect(sql).toMatch(
        /grant execute on function public\.admin_delete_account\(uuid\) to service_role;/i
      );
      expect(sql).not.toMatch(
        /grant execute on function public\.admin_delete_account\(uuid\) to[^;]*(anon|authenticated|public)/i
      );
    }

    const admin = functionBody(functions, "admin_delete_account");
    expect(admin).toMatch(/raise exception 'User id is required'/i);
    expect(admin).toMatch(/public\._delete_account\(p_user_id\)/i);
    expect(admin).not.toMatch(/delete from/i);

    // delete_my_account only points the deletion at the caller.
    const wrapper = functionBody(functions, "delete_my_account");
    expect(wrapper).toMatch(/raise exception 'Not authenticated'/i);
    expect(wrapper).toMatch(/perform public\._delete_account\(v_uid\)/i);
    expect(wrapper).not.toMatch(/delete from/i);

    // The shared path takes the user as an argument and never reads the JWT.
    expect(functionBody(functions, "_delete_account")).not.toMatch(/auth\.uid\(\)/i);
  });

  it("restricts contact_requests reads to the two participants", () => {
    const policies = readSchema("05_policies.sql");

    expect(policies).toMatch(
      /create policy "Participants can view contact requests"[\s\S]*?on public\.contact_requests for select[\s\S]*?using \(requester_id = auth\.uid\(\) or recipient_id = auth\.uid\(\)\)/i
    );
  });

  it("guards the all-pairs group pairwise-balance RPC to authenticated members", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_group_pairwise_balances");

    expect(body).toMatch(/v_uid uuid := auth\.uid\(\)/i);
    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(
      /IF NOT public\.is_group_member\(p_group_id,\s*v_uid\) THEN/i
    );
  });

  it("restricts toggling debt simplification to authenticated members", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "set_group_simplify_debts");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(
      /IF NOT public\.is_group_member\(p_group_id,\s*v_uid\) THEN/i
    );
  });

  it("restricts adding group members to authenticated members", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "add_group_members");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(
      /IF NOT public\.is_group_member\(p_group_id,\s*v_uid\) THEN/i
    );
    // Re-adding an existing member is rejected rather than silently skipped,
    // and unknown addresses are named back to the caller.
    expect(body).toMatch(/Already in this group/i);
    expect(body).toMatch(/No account found for/i);
  });

  it("restricts renaming to members and rejects blank names", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "rename_group");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(
      /IF NOT public\.is_group_member\(p_group_id,\s*v_uid\) THEN/i
    );
    expect(body).toMatch(/btrim\(coalesce\(p_name, ''\)\) = ''/i);
  });

  it("caps email lookup batches and withholds user ids", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "check_emails_registered");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/array_length\(p_emails,\s*1\),\s*0\)\s*>\s*20/i);
    // Returning the matched addresses only. Handing back a uuid per address
    // turned this into an email -> user-id directory, so the signature itself
    // has to stay free of an id column.
    expect(body).toMatch(/select lower\(au\.email\)::text/i);
    expect(functions).toMatch(
      /function public\.check_emails_registered\(p_emails text\[\]\)\s*returns table \(email text\)/i
    );
  });

  it("only answers group-membership probes for groups the caller is in", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "check_group_member_email");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(
      /IF NOT public\.is_group_member\(p_group_id,\s*v_uid\) THEN/i
    );
    expect(body).toMatch(/return 'not_registered'/i);
    expect(body).toMatch(/return 'already_member'/i);
  });

  it("no longer exposes the id-returning email lookup", () => {
    const functions = readSchema("04_functions.sql");

    expect(functions).not.toMatch(/function public\.get_user_ids_by_email/i);
  });

  it("authorizes group expense edits to any member and re-validates splits", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "_update_group_expense");
    const wrapper = functionBody(functions, "update_expense_with_splits");

    // The public RPC supplies the signed-in user as the actor, never a parameter.
    expect(wrapper).toMatch(/raise exception 'Not authenticated'/i);
    expect(wrapper).toMatch(/_update_group_expense\(\s*v_uid,/i);
    expect(body).toMatch(/raise exception 'Expense not found'/i);
    // Any member of the expense's group may edit (mirrors the delete policy).
    expect(body).toMatch(
      /IF NOT public\.is_group_member\(v_group_id,\s*p_actor\) THEN/i
    );
    expect(body).toMatch(
      /IF NOT public\.is_group_member\(v_group_id,\s*p_paid_by\) THEN/i
    );
    expect(body).toMatch(
      /Split amounts must add up to the expense total/i
    );
  });

  it("restricts contact expense edits to participants and re-validates splits", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "_update_contact_expense");
    const wrapper = functionBody(functions, "update_contact_expense_with_splits");

    expect(wrapper).toMatch(/raise exception 'Not authenticated'/i);
    expect(wrapper).toMatch(/_update_contact_expense\(\s*v_uid,/i);
    expect(body).toMatch(/raise exception 'Expense not found'/i);
    expect(body).toMatch(
      /p_actor is distinct from v_lo and p_actor is distinct from v_hi/i
    );
    expect(body).toMatch(/p_paid_by <> v_lo and p_paid_by <> v_hi/i);
    expect(body).toMatch(/Split amounts must add up to the expense total/i);
  });

  it("folds one-on-one contact payments into the contact balance", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "get_contact_balance");

    expect(body).toMatch(/from public\.contact_payments cp/i);
    expect(body).toMatch(
      /cp\.paid_by = v_uid and cp\.paid_to = p_contact_user_id then cp\.base_amount/i
    );
    expect(body).toMatch(
      /cp\.paid_by = p_contact_user_id and cp\.paid_to = v_uid then -cp\.base_amount/i
    );
  });

  it("only lets a party to a payment record or edit it", () => {
    const functions = readSchema("04_functions.sql");
    const create = functionBody(functions, "create_payment");
    const update = functionBody(functions, "update_payment");

    for (const body of [create, update]) {
      expect(body).toMatch(/raise exception 'Not authenticated'/i);
      expect(body).toMatch(/Both people must be group members/i);
      expect(body).toMatch(/Payment amount must be greater than zero/i);
    }

    // Recording and editing now agree: a member who is on neither side of the
    // payment cannot create one or rewrite one between two other people.
    expect(create).toMatch(/v_uid <> p_paid_by and v_uid <> p_paid_to/i);
    expect(update).toMatch(
      /v_uid <> v_existing\.paid_by and v_uid <> v_existing\.paid_to/i
    );
    expect(update).toMatch(/v_uid <> p_paid_by and v_uid <> p_paid_to/i);

    // Currency and base_amount are derived, never taken from the caller.
    expect(create).toMatch(/select g\.currency into v_currency/i);
    expect(update).toMatch(
      /base_amount = round\(v_amount \* v_existing\.exchange_rate, 2\)/i
    );
  });

  it("restricts contact_payments access to the two participants", () => {
    const policies = readSchema("05_policies.sql");
    const functions = readSchema("04_functions.sql");

    expect(policies).toMatch(
      /create policy "Participants can view contact payments"[\s\S]*?on public\.contact_payments for select[\s\S]*?using \(auth\.uid\(\) = user_lo or auth\.uid\(\) = user_hi\)/i
    );

    const create = functionBody(functions, "create_contact_payment");
    expect(create).toMatch(
      /You can only record payments with accepted contacts/i
    );
    expect(create).toMatch(/A payment must be between you and the contact/i);

    const update = functionBody(functions, "update_contact_payment");
    expect(update).toMatch(/v_uid <> v_existing\.user_lo and v_uid <> v_existing\.user_hi/i);

    const del = functionBody(functions, "delete_contact_payment");
    expect(del).toMatch(/v_uid <> v_lo and v_uid <> v_hi/i);
  });

  it("leaves no write policy on any table", () => {
    // RLS cannot express "these splits add up to the expense total", so every
    // write goes through a SECURITY DEFINER RPC and the tables carry SELECT
    // policies only. A write policy reappearing here means a client can reach
    // a table directly again and skip the RPC's validation.
    const policies = readSchema("05_policies.sql");
    const commands = [...policies.matchAll(/for (select|insert|update|delete)/gi)]
      .map((m) => m[1].toLowerCase());

    expect(commands.length).toBeGreaterThan(0);
    expect([...new Set(commands)]).toEqual(["select"]);
  });

  it("grants clients read access only", () => {
    const core = readSchema("02_tables_core.sql");
    const contacts = readSchema("03_tables_contacts.sql");

    for (const schema of [core, contacts]) {
      // Every client-facing grant is a SELECT, and the remainder of Supabase's
      // default `all` (including TRUNCATE, which RLS does not mediate) is
      // revoked rather than left in place.
      const clientGrants = [
        ...schema.matchAll(/grant ([a-z, ]+?) on table[\s\S]*?to ([a-z, ]+);/gi),
      ].filter(([, , roles]) => /anon|authenticated/.test(roles));

      expect(clientGrants.length).toBeGreaterThan(0);
      for (const [, privileges] of clientGrants) {
        expect(privileges.trim()).toBe("select");
      }

      expect(schema).toMatch(
        /revoke insert, update, delete, truncate, references, trigger on table[\s\S]*?from anon, authenticated;/i
      );
    }
  });

  it("lets only group members and the contact pair read recurring schedules", () => {
    const policies = readSchema("05_policies.sql");
    const core = readSchema("02_tables_core.sql");

    expect(policies).toMatch(
      /create policy "Members can view group recurring schedules"[\s\S]*?on public\.recurring_schedules for select[\s\S]*?using \(public\.is_group_member\(group_id, auth\.uid\(\)\)\)/i
    );
    expect(policies).toMatch(
      /create policy "Participants can view contact recurring schedules"[\s\S]*?on public\.recurring_schedules for select[\s\S]*?using \(auth\.uid\(\) = user_lo or auth\.uid\(\) = user_hi\)/i
    );
    const scheduleCommands = [
      ...policies.matchAll(/on public\.recurring_schedules for (\w+)/gi),
    ].map((m) => m[1].toLowerCase());
    expect(scheduleCommands).toEqual(["select", "select"]);

    // Schedules are written only by the RPCs and the engine, so the table has
    // RLS on, a SELECT-only client grant and the remainder revoked.
    expect(core).toMatch(
      /alter table public\.recurring_schedules enable row level security;/i
    );
    expect(core).toMatch(
      /grant select on table[^;]*public\.recurring_schedules[^;]*to anon, authenticated;/i
    );
    expect(core).toMatch(
      /revoke insert, update, delete, truncate, references, trigger on table[^;]*public\.recurring_schedules[^;]*from anon, authenticated;/i
    );
  });

  it("keeps exchange_rates and exchange_rate_requests closed to clients", () => {
    const core = readSchema("02_tables_core.sql");
    const policies = readSchema("05_policies.sql");

    // Only the SECURITY DEFINER rate functions and the service role touch them:
    // RLS on, no policy of any kind, and no privilege left for the API roles.
    for (const table of ["exchange_rates", "exchange_rate_requests"]) {
      expect(core).toMatch(
        new RegExp(`alter table public\\.${table} enable row level security;`, "i")
      );
      expect(core).toMatch(
        new RegExp(`revoke all on table public\\.${table} from anon, authenticated;`, "i")
      );
      expect(policies).not.toMatch(new RegExp(table, "i"));
    }

    const clientGrants = [...core.matchAll(/grant [^;]*;/gi)]
      .map((m) => m[0])
      .filter((statement) => /\bto\b[^;]*\b(anon|authenticated)\b/i.test(statement));
    expect(clientGrants.length).toBeGreaterThan(0);
    for (const statement of clientGrants) {
      expect(statement).not.toMatch(/exchange_rate/i);
    }
  });

  it("scopes profile visibility to shared context", () => {
    const policies = readSchema("05_policies.sql");
    const functions = readSchema("04_functions.sql");

    // Previously `using (true)`: every signed-in account could read the whole
    // user directory.
    expect(policies).toMatch(
      /create policy "Users can view profiles they share context with"[\s\S]*?on public\.profiles for select using \(public\.can_view_profile\(id\)\)/i
    );
    expect(policies).not.toMatch(/for select using \(true\)/i);

    const body = functionBody(functions, "can_view_profile");
    expect(body).toMatch(/p_profile_id = auth\.uid\(\)/i);
    expect(body).toMatch(/from public\.group_members mine/i);
    expect(body).toMatch(/from public\.contacts c/i);
    expect(body).toMatch(/from public\.contact_requests cr/i);
  });

  it("scopes the profile update RPC to the caller and rejects a blank name", () => {
    const functions = readSchema("04_functions.sql");
    const body = functionBody(functions, "update_profile");

    expect(body).toMatch(/raise exception 'Not authenticated'/i);
    expect(body).toMatch(/btrim\(coalesce\(p_full_name, ''\)\) = ''/i);
    expect(body).toMatch(/where id = v_uid/i);
  });

  it("guards every delete RPC on membership or participation", () => {
    const functions = readSchema("04_functions.sql");

    const groupScoped = ["delete_expense", "delete_payment"];
    for (const name of groupScoped) {
      const body = functionBody(functions, name);
      expect(body).toMatch(/raise exception 'Not authenticated'/i);
      expect(body).toMatch(
        /IF NOT public\.is_group_member\(v_group_id,\s*v_uid\) THEN/i
      );
    }

    const pairScoped = ["delete_contact_expense", "delete_contact_payment"];
    for (const name of pairScoped) {
      const body = functionBody(functions, name);
      expect(body).toMatch(/raise exception 'Not authenticated'/i);
      expect(body).toMatch(/v_uid <> v_lo and v_uid <> v_hi/i);
    }
  });

  it("guards the recurring schedule RPCs on the caller, not on a parameter", () => {
    const functions = readSchema("04_functions.sql");

    const create = functionBody(functions, "create_recurring_schedule");
    expect(create).toMatch(/raise exception 'Not authenticated'/i);
    expect(create).toMatch(/public\.is_group_member\(p_group_id, v_uid\)/i);
    expect(create).toMatch(/owner_id = v_uid and contact_user_id = p_contact_id/i);
    expect(create).toMatch(/_insert_group_expense\(\s*v_uid,/i);
    expect(create).toMatch(/_insert_contact_expense\(\s*v_uid,/i);
    expect(create).toMatch(/created_by[\s\S]*?values \([\s\S]*?v_uid/i);
    // Only the normalised splits are stored, never the client's payload.
    expect(create).toMatch(/\(\(t\.e->>'userId'\)::uuid\)::text/i);
    expect(create).toMatch(/p_split_type, v_norm,/i);

    const stop = functionBody(functions, "stop_recurring_schedule");
    expect(stop).toMatch(/raise exception 'Not authenticated'/i);
    expect(stop).toMatch(/public\.is_group_member\(v_schedule\.group_id, v_uid\)/i);
    expect(stop).toMatch(/v_uid <> v_schedule\.user_lo and v_uid <> v_schedule\.user_hi/i);
    expect(stop).toMatch(/for update/i);

    const update = functionBody(functions, "update_recurring_schedule");
    const updateSignature = functions.match(
      /create or replace function public\.update_recurring_schedule\(([\s\S]*?)\)\s*returns/i
    );
    expect(updateSignature?.[1]).not.toMatch(/\bp_(uid|user|user_id|actor|caller)/i);
    expect(update).toMatch(/v_uid uuid := auth\.uid\(\)/i);
    expect(update).toMatch(/raise exception 'Not authenticated'/i);
    expect(update).toMatch(/public\.is_group_member\(v_s\.group_id, v_uid\)/i);
    expect(update).toMatch(/v_uid in \(v_s\.user_lo, v_s\.user_hi\)/i);
    expect(update).toMatch(/_update_group_expense\(\s*v_uid,/i);
    expect(update).toMatch(/_update_contact_expense\(\s*v_uid,/i);
    expect(update).toMatch(/where id = p_schedule_id for update/i);
    expect(functions).toMatch(
      /revoke execute on function public\.update_recurring_schedule\([^;]*from public, anon;/i
    );
    expect(functions).toMatch(
      /grant execute on function public\.update_recurring_schedule\([^;]*to authenticated;/i
    );
    expect(functions).not.toMatch(
      /grant execute on function public\.update_recurring_schedule\([^;]*to[^;]*\banon\b/i
    );

    // leave_group keeps both refusals in one definition.
    const leave = functionBody(functions, "leave_group");
    expect(leave).toMatch(/e\.date > now\(\)/i);
    expect(leave).toMatch(/py\.date > now\(\)/i);
    expect(leave).toMatch(/from public\.recurring_schedules s[\s\S]*?s\.stopped_at is null/i);
    expect(leave).toMatch(/s\.paid_by = v_uid/i);
    // Split users are compared as uuids (not as text), and the creator, who is
    // audit only, does not block.
    expect(leave).toMatch(/\(sp->>'userId'\)::uuid = v_uid/i);
    expect(leave).not.toMatch(/s\.created_by/i);
  });
});
