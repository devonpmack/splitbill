import {
  canDeleteAccount,
  DELETE_CONFIRM_WORD,
  DeletedButStillSignedInError,
} from "@/lib/delete-account";

describe("canDeleteAccount", () => {
  it("needs the word DELETE", () => {
    expect(DELETE_CONFIRM_WORD).toBe("DELETE");
  });

  it("is true only with the box ticked and DELETE typed", () => {
    expect(canDeleteAccount(true, "DELETE")).toBe(true);
  });

  it("is false when the box is not ticked", () => {
    expect(canDeleteAccount(false, "DELETE")).toBe(false);
  });

  it("is false when the word is missing or wrong", () => {
    expect(canDeleteAccount(true, "")).toBe(false);
    expect(canDeleteAccount(true, "DELET")).toBe(false);
    expect(canDeleteAccount(true, "DELETE ME")).toBe(false);
  });

  it("is case sensitive", () => {
    expect(canDeleteAccount(true, "delete")).toBe(false);
    expect(canDeleteAccount(true, "Delete")).toBe(false);
  });

  it("ignores spaces around the word", () => {
    expect(canDeleteAccount(true, "  DELETE  ")).toBe(true);
  });
});

describe("DeletedButStillSignedInError", () => {
  it("is an Error that says the account is gone", () => {
    const error = new DeletedButStillSignedInError();

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(DeletedButStillSignedInError);
    expect(error.message).toMatch(/your account was deleted/i);
  });
});
