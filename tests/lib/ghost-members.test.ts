import { isGhost, payerMembers, splitMembers } from "@/lib/ghost-members";

const me = { user_id: "u1", profiles: { full_name: "Me", deleted_at: null } };
const bob = { user_id: "u2", profiles: { full_name: "Bob" } };
const ghost = {
  user_id: "u3",
  profiles: { full_name: "Deleted user", deleted_at: "2026-11-01T00:00:00Z" },
};
const noProfile = { user_id: "u4", profiles: null };
const members = [me, bob, ghost, noProfile];

describe("ghost members", () => {
  it("a ghost has deleted_at set; a missing profile or a null date is not one", () => {
    expect(isGhost(ghost)).toBe(true);
    expect(isGhost(me)).toBe(false);
    expect(isGhost(bob)).toBe(false);
    expect(isGhost(noProfile)).toBe(false);
  });

  it("a new expense offers no ghost as payer or in the split", () => {
    expect(splitMembers(members).map((m) => m.user_id)).toEqual(["u1", "u2", "u4"]);
    expect(payerMembers(members).map((m) => m.user_id)).toEqual(["u1", "u2", "u4"]);
  });

  it("an edited expense keeps a ghost only in the role they hold", () => {
    const onlyPayer = { paid_by: "u3", expense_splits: [{ user_id: "u1" }] };
    expect(payerMembers(members, onlyPayer).map((m) => m.user_id)).toContain("u3");
    expect(splitMembers(members, onlyPayer).map((m) => m.user_id)).not.toContain("u3");

    const onlySplit = { paid_by: "u1", expense_splits: [{ user_id: "u3" }] };
    expect(splitMembers(members, onlySplit).map((m) => m.user_id)).toContain("u3");
    expect(payerMembers(members, onlySplit).map((m) => m.user_id)).not.toContain("u3");
  });

  it("an expense without splits loaded does not break", () => {
    const e = { paid_by: "u1", expense_splits: null };
    expect(splitMembers(members, e).map((m) => m.user_id)).toEqual(["u1", "u2", "u4"]);
  });
});
