import type { MemberWithProfile } from "@/lib/types";

// A member whose account was deleted stays in the group as a "ghost": their
// profile row is kept (the server shows it as "Deleted user") with deleted_at
// set, so old expenses and balances still add up.
export function isGhost(member: MemberWithProfile): boolean {
  return !!member.profiles?.deleted_at;
}

type InvolvedExpense = {
  paid_by: string;
  expense_splits?: { user_id: string }[] | null;
};

// A new expense never has a ghost as payer or in the split: they can no longer
// settle, and the server refuses it. Editing an expense a ghost is already on
// keeps them, but only in the role they already hold (the server refuses a
// deleted user as a new payer or a new split on an existing expense).

// Who can be ticked into the split.
export function splitMembers<T extends MemberWithProfile>(
  members: T[],
  existingExpense?: InvolvedExpense
): T[] {
  const inSplit = new Set(
    (existingExpense?.expense_splits ?? []).map((s) => s.user_id)
  );
  return members.filter((m) => !isGhost(m) || inSplit.has(m.user_id));
}

// Who can be picked as the payer.
export function payerMembers<T extends MemberWithProfile>(
  members: T[],
  existingExpense?: InvolvedExpense
): T[] {
  return members.filter(
    (m) => !isGhost(m) || existingExpense?.paid_by === m.user_id
  );
}
