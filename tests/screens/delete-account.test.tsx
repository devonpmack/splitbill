import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import DeleteAccount from "@/app/(tabs)/account/delete-account";

const mockDeleteAsync = jest.fn();

const mockSignOut = jest.fn();

jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useDeleteAccount", () => ({
  useDeleteAccount: jest.fn(),
  useMyOpenBalances: jest.fn(),
}));

import { DeletedButStillSignedInError } from "@/lib/delete-account";
import { useAuth } from "@/lib/auth";
import {
  useDeleteAccount,
  useMyOpenBalances,
} from "@/lib/queries/useDeleteAccount";

function setBalances(value: object) {
  (useMyOpenBalances as jest.Mock).mockReturnValue({
    data: [],
    isPending: false,
    isError: false,
    ...value,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDeleteAsync.mockResolvedValue(undefined);
  (useAuth as jest.Mock).mockReturnValue({ signOut: mockSignOut });
  (useDeleteAccount as jest.Mock).mockReturnValue({
    mutateAsync: mockDeleteAsync,
    isPending: false,
  });
  setBalances({});
});

async function tickAndType(word = "DELETE") {
  await fireEvent.press(
    screen.getByLabelText("I understand this can't be undone")
  );
  await fireEvent.changeText(screen.getByPlaceholderText("Type DELETE"), word);
}

describe("DeleteAccount screen", () => {
  it("says what is deleted and what stays", async () => {
    await renderWithPaper(<DeleteAccount />);

    expect(screen.getByText("What gets deleted")).toBeTruthy();
    expect(screen.getByText(/your name, picture and email/i)).toBeTruthy();
    expect(
      screen.getByText(/groups with no one else in them are deleted/i)
    ).toBeTruthy();
    expect(screen.getByText(/repeating expenses you are part of stop/i)).toBeTruthy();
    expect(screen.getByText("What stays")).toBeTruthy();
    expect(screen.getByText(/shown as "Deleted user"/)).toBeTruthy();
  });

  it("lists my open balances by group", async () => {
    setBalances({
      data: [
        { groupId: "g1", groupName: "Trip", currency: "USD", balance: -12.5 },
        { groupId: "g3", groupName: "Lunch", currency: "GBP", balance: 7 },
      ],
    });
    await renderWithPaper(<DeleteAccount />);

    expect(screen.getByText("Trip")).toBeTruthy();
    expect(screen.getByText("you owe $12.50")).toBeTruthy();
    expect(screen.getByText("Lunch")).toBeTruthy();
    expect(screen.getByText("you are owed £7.00")).toBeTruthy();
  });

  it("does not say there are no open balances while they are still loading", async () => {
    setBalances({ data: undefined, isPending: true });
    await renderWithPaper(<DeleteAccount />);

    expect(screen.queryByText("You have no open balances in groups.")).toBeNull();
  });

  it("says there are no open balances when there are none", async () => {
    await renderWithPaper(<DeleteAccount />);

    expect(screen.getByText("You have no open balances in groups.")).toBeTruthy();
  });

  it("still lets me delete when the balances could not be loaded", async () => {
    setBalances({ data: undefined, isError: true });
    await renderWithPaper(<DeleteAccount />);

    expect(screen.getByText(/couldn't load your balances/i)).toBeTruthy();
    await tickAndType();
    await fireEvent.press(screen.getByText("Delete my account"));

    await waitFor(() => expect(mockDeleteAsync).toHaveBeenCalledTimes(1));
  });

  it("says that balances with individual people are not listed", async () => {
    await renderWithPaper(<DeleteAccount />);

    expect(
      screen.getByText(/balances with individual people are not listed here/i)
    ).toBeTruthy();
  });

  it("exposes the tick as a checkbox that reports its state", async () => {
    await renderWithPaper(<DeleteAccount />);
    const tick = () => screen.getByLabelText("I understand this can't be undone");

    expect(tick().props.accessibilityRole).toBe("checkbox");
    expect(tick().props.accessibilityState.checked).toBe(false);

    await fireEvent.press(tick());

    expect(tick().props.accessibilityState.checked).toBe(true);
  });

  it("does not delete until the box is ticked and DELETE is typed", async () => {
    await renderWithPaper(<DeleteAccount />);

    await fireEvent.press(screen.getByText("Delete my account"));
    expect(mockDeleteAsync).not.toHaveBeenCalled();

    await fireEvent.changeText(
      screen.getByPlaceholderText("Type DELETE"),
      "DELETE"
    );
    await fireEvent.press(screen.getByText("Delete my account"));
    expect(mockDeleteAsync).not.toHaveBeenCalled();
  });

  it("does not delete with the box ticked but the wrong word", async () => {
    await renderWithPaper(<DeleteAccount />);

    await tickAndType("delete");
    await fireEvent.press(screen.getByText("Delete my account"));

    expect(mockDeleteAsync).not.toHaveBeenCalled();
  });

  it("deletes once with the box ticked and DELETE typed", async () => {
    await renderWithPaper(<DeleteAccount />);

    await tickAndType();
    await fireEvent.press(screen.getByText("Delete my account"));

    await waitFor(() => expect(mockDeleteAsync).toHaveBeenCalledTimes(1));
  });

  it("shows the error on the screen and stays put when deletion fails", async () => {
    mockDeleteAsync.mockRejectedValue(new Error("Could not delete the account"));
    await renderWithPaper(<DeleteAccount />);

    await tickAndType();
    await fireEvent.press(screen.getByText("Delete my account"));

    expect(await screen.findByText("Could not delete the account")).toBeTruthy();
    expect(screen.getByText("Delete my account")).toBeTruthy();
  });

  it("offers Sign out after an error, in case the account is already gone", async () => {
    mockDeleteAsync.mockRejectedValue(new Error("Could not delete the account"));
    await renderWithPaper(<DeleteAccount />);

    expect(screen.queryByText("Sign out")).toBeNull();
    await tickAndType();
    await fireEvent.press(screen.getByText("Delete my account"));
    await screen.findByText("Could not delete the account");

    await fireEvent.press(screen.getByText("Sign out"));

    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it("tells me the account was deleted when only the sign-out failed", async () => {
    mockDeleteAsync.mockRejectedValue(new DeletedButStillSignedInError());
    await renderWithPaper(<DeleteAccount />);

    await tickAndType();
    await fireEvent.press(screen.getByText("Delete my account"));

    expect(
      await screen.findByText(/your account was deleted/i)
    ).toBeTruthy();
    expect(screen.getByText("Sign out")).toBeTruthy();
  });

  it("falls back to a plain message when the error has no text", async () => {
    mockDeleteAsync.mockRejectedValue({});
    await renderWithPaper(<DeleteAccount />);

    await tickAndType();
    await fireEvent.press(screen.getByText("Delete my account"));

    expect(
      await screen.findByText("Couldn't delete your account. Please try again.")
    ).toBeTruthy();
  });

  it("clears an old error when I try again", async () => {
    mockDeleteAsync.mockRejectedValueOnce(new Error("Could not delete the account"));
    await renderWithPaper(<DeleteAccount />);

    await tickAndType();
    await fireEvent.press(screen.getByText("Delete my account"));
    await screen.findByText("Could not delete the account");

    await fireEvent.press(screen.getByText("Delete my account"));

    await waitFor(() =>
      expect(screen.queryByText("Could not delete the account")).toBeNull()
    );
    expect(mockDeleteAsync).toHaveBeenCalledTimes(2);
  });

  it("does not send a second delete while one is running", async () => {
    (useDeleteAccount as jest.Mock).mockReturnValue({
      mutateAsync: mockDeleteAsync,
      isPending: true,
    });
    await renderWithPaper(<DeleteAccount />);

    await tickAndType();
    await fireEvent.press(screen.getByText("Delete my account"));

    expect(mockDeleteAsync).not.toHaveBeenCalled();
  });
});
