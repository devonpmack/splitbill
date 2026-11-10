// Pure rules for the Delete account screen.

export const DELETE_CONFIRM_WORD = "DELETE";

// The delete button needs both an explicit tick and the typed word. Case
// matters; spaces around the word do not.
export function canDeleteAccount(acknowledged: boolean, typed: string): boolean {
  return acknowledged && typed.trim() === DELETE_CONFIRM_WORD;
}

// delete_my_account worked, but signing out on this device did not (for
// example no network). The account is gone, so retrying the delete cannot
// work: the screen offers Sign out instead.
export class DeletedButStillSignedInError extends Error {
  constructor() {
    super(
      "Your account was deleted, but this device is still signed in. " +
        "Check your connection, then sign out."
    );
    this.name = "DeletedButStillSignedInError";
  }
}

// One group where my net balance is not zero. A positive balance means I am
// owed, a negative one means I owe. `currency` is the group's own currency.
export interface OpenBalance {
  groupId: string;
  groupName: string;
  currency: string;
  balance: number;
}
