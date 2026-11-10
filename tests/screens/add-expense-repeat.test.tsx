import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { freezeNow, renderWithPaper, typeDate } from "../helpers/testUtils";
import AddExpense from "@/app/group-add-expense";
import { ContactAddExpenseScreen as AddContactExpense } from "@/components/contacts/ContactAddExpenseScreen";

const mockBack = jest.fn();
const mockCreateExpense = jest.fn();
const mockCreateSchedule = jest.fn();
const mockShowError = jest.fn();
const mockParams: {
  groupId?: string;
  contactUserId?: string;
  expenseId?: string;
} = {};

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
jest.mock("@/lib/queries/useContacts", () => ({
  useContacts: jest.fn(),
  useContactCurrency: jest.fn(),
}));
jest.mock("@/lib/queries/useContactExpenses", () => ({
  useContactExpenses: jest.fn(),
  useCreateContactExpense: jest.fn(),
  useUpdateContactExpense: jest.fn(),
}));
jest.mock("@/lib/queries/useRecurringSchedules", () => ({
  useCreateRecurringSchedule: jest.fn(),
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
import { useContacts, useContactCurrency } from "@/lib/queries/useContacts";
import {
  useContactExpenses,
  useCreateContactExpense,
  useUpdateContactExpense,
} from "@/lib/queries/useContactExpenses";
import { useCreateRecurringSchedule } from "@/lib/queries/useRecurringSchedules";
import { useSnackbar } from "@/lib/snackbar";

const deviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const group = {
  id: "g1",
  name: "Flat",
  group_members: [
    { user_id: "u1", profiles: { full_name: "Me" } },
    { user_id: "u2", profiles: { full_name: "Bob" } },
  ],
};

const pending = { mutateAsync: jest.fn(), isPending: false };

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.groupId = "g1";
  mockParams.contactUserId = undefined;
  mockParams.expenseId = undefined;
  mockCreateExpense.mockResolvedValue({ id: "exp-1" });
  mockCreateSchedule.mockResolvedValue({ id: "sched-1" });
  (router as unknown as { back: jest.Mock }).back = mockBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "u1" } });
  (useGroup as jest.Mock).mockReturnValue({ data: group });
  (useExpenses as jest.Mock).mockReturnValue({ data: [] });
  (useCreateExpense as jest.Mock).mockReturnValue({
    mutateAsync: mockCreateExpense,
    isPending: false,
  });
  (useUpdateExpense as jest.Mock).mockReturnValue(pending);
  (useContacts as jest.Mock).mockReturnValue({
    data: [{ contact_user_id: "u2", full_name: "Bob", balance: 0 }],
  });
  (useContactCurrency as jest.Mock).mockReturnValue({ data: "USD" });
  (useContactExpenses as jest.Mock).mockReturnValue({ data: [] });
  (useCreateContactExpense as jest.Mock).mockReturnValue({
    mutateAsync: mockCreateExpense,
    isPending: false,
  });
  (useUpdateContactExpense as jest.Mock).mockReturnValue(pending);
  (useCreateRecurringSchedule as jest.Mock).mockReturnValue({
    mutateAsync: mockCreateSchedule,
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({ showError: mockShowError });
  freezeNow(new Date(2026, 10, 9, 15, 0));
});

afterEach(() => jest.useRealTimers());

async function fillBasics() {
  await fireEvent.changeText(
    screen.getByPlaceholderText("What was this expense for?"),
    "Rent"
  );
  await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "30");
}

async function chooseRepeat(label: string) {
  await fireEvent.press(screen.getByText(label));
}

const submit = () => fireEvent.press(screen.getByText("Add Expense"));

describe("Repeat control on the add expense form", () => {
  it("defaults to not repeating and offers no end options", async () => {
    await renderWithPaper(<AddExpense />);

    expect(screen.getByText("Repeat")).toBeTruthy();
    expect(screen.getByText("Does not repeat")).toBeTruthy();
    expect(screen.queryByText("Ends")).toBeNull();
    expect(screen.queryByText("After")).toBeNull();
  });

  it("lists every frequency", async () => {
    await renderWithPaper(<AddExpense />);

    for (const label of [
      "Does not repeat",
      "Daily",
      "Weekly",
      "Every 2 weeks",
      "Monthly",
      "Yearly",
    ]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("submits the plain expense path unchanged when it does not repeat", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();

    await submit();

    await waitFor(() => expect(mockCreateExpense).toHaveBeenCalledTimes(1));
    expect(mockCreateExpense).toHaveBeenCalledWith({
      groupId: "g1",
      paidBy: "u1",
      description: "Rent",
      amount: 30,
      splitType: "equal",
      splits: [
        { userId: "u1", amount: 15 },
        { userId: "u2", amount: 15 },
      ],
      currency: "USD",
      exchangeRate: 1,
    });
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it.each([
    ["Daily", "daily"],
    ["Weekly", "weekly"],
    ["Every 2 weeks", "biweekly"],
    ["Monthly", "monthly"],
    ["Yearly", "yearly"],
  ])("repeating %s creates a %s schedule", async (label, frequency) => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();
    await chooseRepeat(label);

    await submit();

    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
    expect(mockCreateSchedule.mock.calls[0][0].frequency).toBe(frequency);
  });

  it("submits the exact schedule args, starting today, ending never", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();
    await chooseRepeat("Monthly");

    await submit();

    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
    expect(mockCreateSchedule).toHaveBeenCalledWith({
      scope: { kind: "group", groupId: "g1" },
      paidBy: "u1",
      description: "Rent",
      amount: 30,
      splitType: "equal",
      splits: [
        { userId: "u1", amount: 15 },
        { userId: "u2", amount: 15 },
      ],
      currency: "USD",
      exchangeRate: 1,
      startDate: "2026-11-09",
      timeZone: deviceZone,
      frequency: "monthly",
    });
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it("does not call the plain create expense when repeating", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();
    await chooseRepeat("Weekly");

    await submit();

    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalled());
    expect(mockCreateExpense).not.toHaveBeenCalled();
  });

  it("uses the picked day as the start date, as YYYY-MM-DD", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();
    await chooseRepeat("Monthly");
    await fireEvent.changeText(screen.getByTestId("date-field"), "11/12/2026");

    await submit();

    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
    expect(mockCreateSchedule.mock.calls[0][0].startDate).toBe("2026-11-12");
  });

  it("allows a start date in the past", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();
    await chooseRepeat("Weekly");
    await fireEvent.changeText(screen.getByTestId("date-field"), "10/20/2026");

    await submit();

    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
    expect(mockCreateSchedule.mock.calls[0][0].startDate).toBe("2026-10-20");
    expect(mockShowError).not.toHaveBeenCalled();
  });

  it("refuses an impossible start date while repeating", async () => {
    await renderWithPaper(<AddExpense />);
    await fillBasics();
    await chooseRepeat("Monthly");
    await typeDate(screen.getByTestId("date-field"), "02/30/2026");

    await submit();

    expect(mockShowError).toHaveBeenCalledWith("Please enter a valid date");
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  describe("ends", () => {
    it("offers Never, On date and After once a frequency is set, Never selected", async () => {
      await renderWithPaper(<AddExpense />);
      await chooseRepeat("Monthly");

      expect(screen.getByText("Ends")).toBeTruthy();
      expect(screen.getByText("Never")).toBeTruthy();
      expect(screen.getByText("On date")).toBeTruthy();
      expect(screen.getByText("After")).toBeTruthy();
      expect(screen.queryByTestId("end-date-field")).toBeNull();
      expect(screen.queryByLabelText("Number of times")).toBeNull();
    });

    it("hides the end options again when set back to not repeating", async () => {
      await renderWithPaper(<AddExpense />);
      await chooseRepeat("Monthly");
      await chooseRepeat("Does not repeat");

      expect(screen.queryByText("Ends")).toBeNull();
    });

    it("On date: proposes one step after the start and sends the typed end date", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();
      await chooseRepeat("Monthly");
      await fireEvent.press(screen.getByText("On date"));

      expect(screen.getByTestId("end-date-field")).toHaveProp(
        "value",
        "12/09/2026"
      );
      expect(screen.queryByText(/Counts toward balances/)).toBeNull();

      await fireEvent.changeText(
        screen.getByTestId("end-date-field"),
        "01/15/2027"
      );
      await submit();

      await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
      const args = mockCreateSchedule.mock.calls[0][0];
      expect(args.endDate).toBe("2027-01-15");
      expect(args.maxCount).toBeUndefined();
    });

    it("On date: sends the proposed end date untouched", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();
      await chooseRepeat("Weekly");
      await fireEvent.press(screen.getByText("On date"));

      await submit();

      await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
      expect(mockCreateSchedule.mock.calls[0][0].endDate).toBe("2026-11-16");
    });

    it("On date: refuses an impossible end date", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();
      await chooseRepeat("Monthly");
      await fireEvent.press(screen.getByText("On date"));
      await typeDate(screen.getByTestId("end-date-field"), "02/30/2027");

      await submit();

      expect(mockShowError).toHaveBeenCalledWith(
        "Please enter a valid end date"
      );
      expect(mockCreateSchedule).not.toHaveBeenCalled();
    });

    it("After N times: sends the count and says when the last one falls", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();
      await chooseRepeat("Monthly");
      await fireEvent.press(screen.getByText("After"));

      expect(screen.getByLabelText("Number of times")).toBeTruthy();
      await fireEvent.changeText(screen.getByLabelText("Number of times"), "3");
      expect(screen.getByText("The last one is on Jan 9, 2027.")).toBeTruthy();
      await submit();

      await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
      const args = mockCreateSchedule.mock.calls[0][0];
      expect(args.maxCount).toBe(3);
      expect(args.endDate).toBeUndefined();
    });

    it.each(["0", "", "abc", "2.5", "-1"])(
      "After N times: refuses %p",
      async (text) => {
        await renderWithPaper(<AddExpense />);
        await fillBasics();
        await chooseRepeat("Monthly");
        await fireEvent.press(screen.getByText("After"));
        await fireEvent.changeText(
          screen.getByLabelText("Number of times"),
          text
        );

        await submit();

        expect(mockShowError).toHaveBeenCalledWith(
          "Number of repeats must be greater than zero"
        );
        expect(mockCreateSchedule).not.toHaveBeenCalled();
      }
    );

    it("switching back to Never drops the limit", async () => {
      await renderWithPaper(<AddExpense />);
      await fillBasics();
      await chooseRepeat("Monthly");
      await fireEvent.press(screen.getByText("After"));
      await fireEvent.changeText(screen.getByLabelText("Number of times"), "3");
      await fireEvent.press(screen.getByText("Never"));

      await submit();

      await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
      const args = mockCreateSchedule.mock.calls[0][0];
      expect(args.maxCount).toBeUndefined();
      expect(args.endDate).toBeUndefined();
    });
  });

  it("shows the server's error and stays on the form", async () => {
    mockCreateSchedule.mockRejectedValueOnce(
      new Error("Start date cannot be more than 31 days in the past")
    );
    await renderWithPaper(<AddExpense />);
    await fillBasics();
    await chooseRepeat("Monthly");

    await submit();

    await waitFor(() =>
      expect(mockShowError).toHaveBeenCalledWith(
        "Start date cannot be more than 31 days in the past"
      )
    );
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("validates like a plain expense before creating a schedule", async () => {
    await renderWithPaper(<AddExpense />);
    await chooseRepeat("Monthly");

    await submit();

    expect(mockShowError).toHaveBeenCalledWith("Please enter a description");
    expect(mockCreateSchedule).not.toHaveBeenCalled();
  });

  it("is not offered when editing an expense", async () => {
    mockParams.expenseId = "exp-1";
    (useExpenses as jest.Mock).mockReturnValue({
      data: [
        {
          id: "exp-1",
          description: "Rent",
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
    await renderWithPaper(<AddExpense />);

    expect(screen.queryByText("Repeat")).toBeNull();
    expect(screen.queryByText("Does not repeat")).toBeNull();
    expect(screen.queryByText("Ends")).toBeNull();
  });

  it("creates a contact schedule for the other person", async () => {
    mockParams.groupId = undefined;
    mockParams.contactUserId = "u2";
    await renderWithPaper(<AddContactExpense />);
    await fillBasics();
    await chooseRepeat("Every 2 weeks");

    await submit();

    await waitFor(() => expect(mockCreateSchedule).toHaveBeenCalledTimes(1));
    expect(mockCreateSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: "contact", contactUserId: "u2" },
        frequency: "biweekly",
        startDate: "2026-11-09",
        timeZone: deviceZone,
      })
    );
    expect(mockCreateExpense).not.toHaveBeenCalled();
  });

  it("contact form: not offered when editing", async () => {
    mockParams.groupId = undefined;
    mockParams.contactUserId = "u2";
    mockParams.expenseId = "ce-1";
    await renderWithPaper(<AddContactExpense />);

    expect(screen.queryByText("Repeat")).toBeNull();
    expect(screen.queryByText("Monthly")).toBeNull();
  });
});
