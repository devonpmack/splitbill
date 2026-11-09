import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { freezeNow, renderWithPaper } from "../helpers/testUtils";
import { startOfLocalDayISO } from "@/lib/dates";
import { ContactAddExpenseScreen as AddContactExpense } from "@/components/contacts/ContactAddExpenseScreen";

const mockBack = jest.fn();
const mockMutateAsync = jest.fn();
const mockShowError = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => ({ contactUserId: "user-2" }),
  Stack: { Screen: () => null },
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useContacts", () => ({
  useContacts: jest.fn(),
  useContactCurrency: jest.fn(),
}));
jest.mock("@/lib/queries/useContactExpenses", () => ({
  useContactExpenses: jest.fn(),
  useCreateContactExpense: jest.fn(),
  useUpdateContactExpense: jest.fn(),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import {
  useContacts,
  useContactCurrency,
} from "@/lib/queries/useContacts";
import {
  useContactExpenses,
  useCreateContactExpense,
  useUpdateContactExpense,
} from "@/lib/queries/useContactExpenses";
import { useSnackbar } from "@/lib/snackbar";

beforeEach(() => {
  jest.clearAllMocks();
  mockMutateAsync.mockResolvedValue({ id: "ce-1" });
  (router as unknown as { back: jest.Mock }).back = mockBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "user-1" } });
  (useContacts as jest.Mock).mockReturnValue({
    data: [{ contact_user_id: "user-2", full_name: "Bob", balance: 0 }],
  });
  (useContactExpenses as jest.Mock).mockReturnValue({ data: [] });
  (useContactCurrency as jest.Mock).mockReturnValue({ data: "USD" });
  (useCreateContactExpense as jest.Mock).mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
  (useUpdateContactExpense as jest.Mock).mockReturnValue({
    mutateAsync: jest.fn(),
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({ showError: mockShowError });
});

describe("AddContactExpense screen", () => {
  it("validates an empty description", async () => {
    await renderWithPaper(<AddContactExpense />);

    await fireEvent.press(screen.getByText("Add Expense"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a description");
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  describe("date", () => {
    beforeEach(() => freezeNow(new Date(2026, 10, 9, 15, 0)));
    afterEach(() => jest.useRealTimers());

    it("sends the start of a picked future day", async () => {
      await renderWithPaper(<AddContactExpense />);

      await fireEvent.changeText(
        screen.getByPlaceholderText("What was this expense for?"),
        "Coffee"
      );
      await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "8");
      await fireEvent.changeText(screen.getByTestId("date-field"), "11/12/2026");
      expect(
        screen.getByText("Counts toward balances from Nov 12, 2026.")
      ).toBeTruthy();
      await fireEvent.press(screen.getByText("Add Expense"));

      await waitFor(() =>
        expect(mockMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            contactUserId: "user-2",
            date: startOfLocalDayISO(new Date(2026, 10, 12)),
          })
        )
      );
    });
  });

  it("validates a non-positive amount", async () => {
    await renderWithPaper(<AddContactExpense />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("What was this expense for?"),
      "Coffee"
    );
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "0");
    await fireEvent.press(screen.getByText("Add Expense"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a valid amount");
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("submits an equal split between you and the contact", async () => {
    await renderWithPaper(<AddContactExpense />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("What was this expense for?"),
      "  Dinner  "
    );
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "30");

    await fireEvent.press(screen.getByText("Add Expense"));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      contactUserId: "user-2",
      paidBy: "user-1",
      description: "Dinner",
      amount: 30,
      splitType: "equal",
      splits: [
        { userId: "user-1", amount: 15 },
        { userId: "user-2", amount: 15 },
      ],
      currency: "USD",
      exchangeRate: 1,
    });
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it("surfaces a submit failure without navigating", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error("Network down"));
    await renderWithPaper(<AddContactExpense />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("What was this expense for?"),
      "Dinner"
    );
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "30");
    await fireEvent.press(screen.getByText("Add Expense"));

    await waitFor(() =>
      expect(mockShowError).toHaveBeenCalledWith("Network down")
    );
    expect(mockBack).not.toHaveBeenCalled();
  });
});
