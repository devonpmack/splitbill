import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { freezeNow, renderWithPaper, typeDate } from "../helpers/testUtils";
import { startOfLocalDayISO } from "@/lib/dates";
import AddExpense from "@/app/group-add-expense";

const mockBack = jest.fn();
const mockMutateAsync = jest.fn();
const mockUpdateMutateAsync = jest.fn();
const mockShowError = jest.fn();
const mockParams: { groupId: string; expenseId?: string } = { groupId: "g1" };

jest.mock("expo-router", () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useGroups", () => ({ useGroup: jest.fn() }));
jest.mock("@/lib/queries/useExpenses", () => ({
  useCreateExpense: jest.fn(),
  useExpenses: jest.fn(),
  useUpdateExpense: jest.fn(),
}));
jest.mock("@/lib/queries/useRecurringSchedules", () => ({
  useCreateRecurringSchedule: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import { useGroup } from "@/lib/queries/useGroups";
import {
  useCreateExpense,
  useExpenses,
  useUpdateExpense,
} from "@/lib/queries/useExpenses";
import { useSnackbar } from "@/lib/snackbar";

const group = {
  id: "g1",
  name: "Trip",
  group_members: [
    { user_id: "u1", profiles: { full_name: "Me" } },
    { user_id: "u2", profiles: { full_name: "Bob" } },
    { user_id: "u3", profiles: { full_name: "Cara" } },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.groupId = "g1";
  mockParams.expenseId = undefined;
  mockMutateAsync.mockResolvedValue({ id: "exp-1" });
  mockUpdateMutateAsync.mockResolvedValue({ id: "exp-1" });
  (router as unknown as { back: jest.Mock }).back = mockBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "u1" } });
  (useGroup as jest.Mock).mockReturnValue({ data: group });
  (useCreateExpense as jest.Mock).mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
  (useExpenses as jest.Mock).mockReturnValue({ data: [] });
  (useUpdateExpense as jest.Mock).mockReturnValue({
    mutateAsync: mockUpdateMutateAsync,
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({ showError: mockShowError });
});

describe("AddExpense screen", () => {
  it("shows a validation error and does not submit when the description is empty", async () => {
    await renderWithPaper(<AddExpense />);

    await fireEvent.press(screen.getByText("Add Expense"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a description");
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("shows a validation error for a non-positive amount", async () => {
    await renderWithPaper(<AddExpense />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("What was this expense for?"),
      "Dinner"
    );
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "0");

    await fireEvent.press(screen.getByText("Add Expense"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a valid amount");
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("submits an equal split and navigates back on success", async () => {
    await renderWithPaper(<AddExpense />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("What was this expense for?"),
      "  Dinner  "
    );
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "30");

    await fireEvent.press(screen.getByText("Add Expense"));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      groupId: "g1",
      paidBy: "u1",
      description: "Dinner",
      amount: 30,
      splitType: "equal",
      splits: [
        { userId: "u1", amount: 10 },
        { userId: "u2", amount: 10 },
        { userId: "u3", amount: 10 },
      ],
      currency: "USD",
      exchangeRate: 1,
    });
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it("surfaces a submit failure via the snackbar without navigating", async () => {
    mockMutateAsync.mockRejectedValueOnce(new Error("Network down"));
    await renderWithPaper(<AddExpense />);

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

  async function fillBasics() {
    await fireEvent.changeText(
      screen.getByPlaceholderText("What was this expense for?"),
      "Dinner"
    );
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "30");
  }

  it("submits an exact split with per-member amounts", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();

    await fireEvent.press(screen.getByText("Exact"));
    const inputs = screen.getAllByPlaceholderText("$0.00");
    await fireEvent.changeText(inputs[0], "10");
    await fireEvent.changeText(inputs[1], "12");
    await fireEvent.changeText(inputs[2], "8");

    await fireEvent.press(screen.getByText("Add Expense"));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        splitType: "exact",
        splits: [
          { userId: "u1", amount: 10 },
          { userId: "u2", amount: 12 },
          { userId: "u3", amount: 8 },
        ],
      })
    );
  });

  it("rejects an exact split that does not reconcile to the total", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();

    await fireEvent.press(screen.getByText("Exact"));
    const inputs = screen.getAllByPlaceholderText("$0.00");
    await fireEvent.changeText(inputs[0], "10");
    await fireEvent.changeText(inputs[1], "10");
    await fireEvent.changeText(inputs[2], "5");

    await fireEvent.press(screen.getByText("Add Expense"));

    expect(mockShowError).toHaveBeenCalledWith(
      "Split amounts ($25.00) don't add up to total ($30.00)"
    );
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("submits a percentage split distributing the total", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();

    await fireEvent.press(screen.getByText("%"));
    const inputs = screen.getAllByPlaceholderText("%");
    await fireEvent.changeText(inputs[0], "50");
    await fireEvent.changeText(inputs[1], "30");
    await fireEvent.changeText(inputs[2], "20");

    await fireEvent.press(screen.getByText("Add Expense"));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        splitType: "percentage",
        splits: [
          { userId: "u1", amount: 15 },
          { userId: "u2", amount: 9 },
          { userId: "u3", amount: 6 },
        ],
      })
    );
  });

  it("rejects a percentage split that does not total 100%", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();

    await fireEvent.press(screen.getByText("%"));
    const inputs = screen.getAllByPlaceholderText("%");
    await fireEvent.changeText(inputs[0], "40");
    await fireEvent.changeText(inputs[1], "40");
    await fireEvent.changeText(inputs[2], "10");

    await fireEvent.press(screen.getByText("Add Expense"));

    expect(mockShowError).toHaveBeenCalledWith(
      "Percentages must add up to 100% (currently 90.0%)"
    );
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  describe("date", () => {
    beforeEach(() => freezeNow(new Date(2026, 10, 9, 15, 0)));
    afterEach(() => jest.useRealTimers());

    it("defaults to today and sends no date, so the server uses now", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();

      expect(screen.getByTestId("date-field")).toHaveProp("value", "11/09/2026");
      expect(screen.queryByText(/Counts toward balances/)).toBeNull();
      await fireEvent.press(screen.getByText("Add Expense"));

      await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
      expect(mockMutateAsync.mock.calls[0][0].date).toBeUndefined();
    });

    it("sends the start of a picked future day and says when it counts", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();

      await fireEvent.changeText(screen.getByTestId("date-field"), "11/12/2026");
      expect(
        screen.getByText("Counts toward balances from Nov 12, 2026.")
      ).toBeTruthy();
      await fireEvent.press(screen.getByText("Add Expense"));

      await waitFor(() =>
        expect(mockMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            date: startOfLocalDayISO(new Date(2026, 10, 12)),
          })
        )
      );
    });

    it.each(["02/30/2026", "13/45/2026", "01/01/0026"])(
      "refuses to submit the impossible date %s",
      async (text) => {
        await renderWithPaper(<AddExpense />);
        await fillBasics();

        await typeDate(screen.getByTestId("date-field"), text);
        await fireEvent.press(screen.getByText("Add Expense"));

        expect(mockShowError).toHaveBeenCalledWith("Please enter a valid date");
        expect(mockMutateAsync).not.toHaveBeenCalled();
      }
    );

    it("submits a real leap day", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();

      await typeDate(screen.getByTestId("date-field"), "02/29/2028");
      await fireEvent.press(screen.getByText("Add Expense"));

      await waitFor(() =>
        expect(mockMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            date: startOfLocalDayISO(new Date(2028, 1, 29)),
          })
        )
      );
    });

    it("refuses to submit an incomplete date", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();

      await fireEvent(screen.getByTestId("date-field"), "change", {
        nativeEvent: { text: "11/1" },
      });
      await fireEvent.press(screen.getByText("Add Expense"));

      expect(mockShowError).toHaveBeenCalledWith("Please enter a valid date");
      expect(mockMutateAsync).not.toHaveBeenCalled();
    });
  });

  describe("edit mode", () => {
    beforeEach(() => {
      mockParams.expenseId = "exp-1";
      (useExpenses as jest.Mock).mockReturnValue({
        data: [
          {
            id: "exp-1",
            description: "Old dinner",
            amount: 30,
            paid_by: "u1",
            split_type: "equal",
            expense_splits: [
              { user_id: "u1", amount: 15 },
              { user_id: "u2", amount: 15 },
            ],
          },
        ],
      });
    });

    it("submits the update RPC with the expense id", async () => {
      await renderWithPaper(<AddExpense />);

      await fireEvent.press(screen.getByText("Save Changes"));

      await waitFor(() =>
        expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1)
      );
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          expenseId: "exp-1",
          groupId: "g1",
          description: "Old dinner",
          amount: 30,
          splitType: "equal",
          splits: [
            { userId: "u1", amount: 15 },
            { userId: "u2", amount: 15 },
          ],
        })
      );
      expect(mockMutateAsync).not.toHaveBeenCalled();
      await waitFor(() => expect(mockBack).toHaveBeenCalled());
    });

    describe("date", () => {
      beforeEach(() => freezeNow(new Date(2026, 10, 9, 15, 0)));
      afterEach(() => jest.useRealTimers());

      beforeEach(() => {
        (useExpenses as jest.Mock).mockReturnValue({
          data: [
            {
              id: "exp-1",
              description: "Old dinner",
              amount: 30,
              paid_by: "u1",
              split_type: "equal",
              date: new Date(2026, 10, 5, 15).toISOString(),
              expense_splits: [
                { user_id: "u1", amount: 15 },
                { user_id: "u2", amount: 15 },
              ],
            },
          ],
        });
      });

      it("prefills the stored day and sends no date when it is unchanged", async () => {
        await renderWithPaper(<AddExpense />);

        expect(screen.getByTestId("date-field")).toHaveProp(
          "value",
          "11/05/2026"
        );
        await fireEvent.press(screen.getByText("Save Changes"));

        await waitFor(() =>
          expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1)
        );
        expect(mockUpdateMutateAsync.mock.calls[0][0].date).toBeUndefined();
      });

      it("prefills a scheduled row with its schedule's day, not the instant in this zone", async () => {
        (useExpenses as jest.Mock).mockReturnValue({
          data: [
            {
              id: "exp-1",
              description: "Rent",
              amount: 30,
              paid_by: "u1",
              split_type: "equal",
              schedule_id: "s1",
              occurrence_date: "2026-11-05",
              date: new Date(2026, 10, 2, 15).toISOString(),
              expense_splits: [
                { user_id: "u1", amount: 15 },
                { user_id: "u2", amount: 15 },
              ],
            },
          ],
        });
        await renderWithPaper(<AddExpense />);

        expect(screen.getByTestId("date-field")).toHaveProp(
          "value",
          "11/05/2026"
        );
        await fireEvent.press(screen.getByText("Save Changes"));

        await waitFor(() =>
          expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1)
        );
        expect(mockUpdateMutateAsync.mock.calls[0][0].date).toBeUndefined();
      });

      it("sends the start of a newly picked day", async () => {
        await renderWithPaper(<AddExpense />);

        await fireEvent.changeText(
          screen.getByTestId("date-field"),
          "11/12/2026"
        );
        await fireEvent.press(screen.getByText("Save Changes"));

        await waitFor(() =>
          expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
            expect.objectContaining({
              date: startOfLocalDayISO(new Date(2026, 10, 12)),
            })
          )
        );
      });
    });

    it("keeps the rate the expense was booked at instead of today's rate", async () => {
      // Booked at 1.05 EUR->USD; the mocked live rate is 2.
      (useExpenses as jest.Mock).mockReturnValue({
        data: [
          {
            id: "exp-1",
            description: "Old dinner",
            amount: 30,
            paid_by: "u1",
            split_type: "equal",
            currency: "EUR",
            exchange_rate: 1.05,
            expense_splits: [
              { user_id: "u1", amount: 15 },
              { user_id: "u2", amount: 15 },
            ],
          },
        ],
      });

      await renderWithPaper(<AddExpense />);
      await fireEvent.press(screen.getByText("Save Changes"));

      await waitFor(() =>
        expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1)
      );
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ currency: "EUR", exchangeRate: 1.05 })
      );
    });

  });
});
