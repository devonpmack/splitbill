import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithPaper, actAsync } from "../helpers/testUtils";
import ContactDetail from "@/app/(tabs)/(home)/contacts/[id]";
import ActivityContactDetail from "@/app/(tabs)/activity/contacts/[id]";

const mockPush = jest.fn();
const mockDeleteMutate = jest.fn();
const mockDeletePaymentMutate = jest.fn();
const mockShowError = jest.fn();
const mockConfirm = jest.fn();
// Captures whatever Stack.Screen was handed, so a test can assert the
// header options the screen set.
type ScreenOptions = {
  title?: string;
  headerRight?: () => { props: { onPress: () => void } };
};
const mockScreenHolder: { options: ScreenOptions | null } = {
  options: null,
};

// Reading through a null options means Stack.Screen never rendered, which is a
// test-setup bug rather than something to assert around.
function screenOptions(): ScreenOptions {
  if (!mockScreenHolder.options) {
    throw new Error("Stack.Screen did not render");
  }
  return mockScreenHolder.options;
}
const mockParams: { id: string; name?: string } = { id: "user-2" };

jest.mock("expo-router", () => ({
  router: { push: jest.fn() },
  useLocalSearchParams: () => mockParams,
  Stack: {
    Screen: (props: { options: ScreenOptions }) => {
      mockScreenHolder.options = props.options;
      return null;
    },
  },
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useContacts", () => ({
  useContacts: jest.fn(),
  useContactBalance: jest.fn(),
  useContactCurrency: jest.fn(),
  useContactGroupBreakdown: jest.fn(),
  useSetContactCurrency: jest.fn(),
}));
jest.mock("@/lib/queries/useContactExpenses", () => ({
  useContactExpenses: jest.fn(),
  useDeleteContactExpense: jest.fn(),
}));
jest.mock("@/lib/queries/useContactPayments", () => ({
  useContactPayments: jest.fn(),
  useDeleteContactPayment: jest.fn(),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));
jest.mock("@/lib/queries/useRecurringSchedules", () => ({
  useScheduleFrequencies: () => ({ data: { s1: "monthly" } }),
}));
jest.mock("@/lib/confirm", () => ({ useConfirm: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import {
  useContacts,
  useContactBalance,
  useContactCurrency,
  useContactGroupBreakdown,
  useSetContactCurrency,
} from "@/lib/queries/useContacts";
import {
  useContactExpenses,
  useDeleteContactExpense,
} from "@/lib/queries/useContactExpenses";
import {
  useContactPayments,
  useDeleteContactPayment,
} from "@/lib/queries/useContactPayments";
import { useSnackbar } from "@/lib/snackbar";
import { useConfirm } from "@/lib/confirm";

const expensesFixture = [
  {
    id: "ce-1",
    description: "Dinner",
    amount: 30,
    paid_by: "user-1",
    payer: { full_name: "Me" },
    date: "2024-01-01",
    expense_splits: [
      { id: "s1", user_id: "user-1", amount: 15, profiles: { full_name: "Me" } },
      { id: "s2", user_id: "user-2", amount: 15, profiles: { full_name: "Bob" } },
    ],
  },
];

const paymentsFixture = [
  {
    id: "cp-1",
    amount: 20,
    paid_by: "user-1",
    paid_to: "user-2",
    payer: { full_name: "Me" },
    payee: { full_name: "Bob" },
    note: "Venmo",
    created_at: "2024-01-03",
    date: "2024-01-03",
  },
];

function setup(overrides?: {
  balance?: number;
  expenses?: unknown;
  payments?: unknown;
  groupBreakdown?: unknown[];
}) {
  (useContactBalance as jest.Mock).mockReturnValue({
    data: overrides?.balance ?? 15,
    refetch: jest.fn().mockResolvedValue(undefined),
  });
  (useContactExpenses as jest.Mock).mockReturnValue({
    data: overrides && "expenses" in overrides ? overrides.expenses : expensesFixture,
    refetch: jest.fn().mockResolvedValue(undefined),
  });
  (useContactPayments as jest.Mock).mockReturnValue({
    data: overrides && "payments" in overrides ? overrides.payments : [],
    refetch: jest.fn().mockResolvedValue(undefined),
  });
  (useContactGroupBreakdown as jest.Mock).mockReturnValue({
    data: overrides?.groupBreakdown ?? [],
    refetch: jest.fn().mockResolvedValue(undefined),
  });
  (useContactCurrency as jest.Mock).mockReturnValue({ data: "USD" });
  (useSetContactCurrency as jest.Mock).mockReturnValue({
    mutate: jest.fn(),
    isPending: false,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScreenHolder.options = null;
  mockParams.id = "user-2";
  mockParams.name = undefined;
  (router as unknown as Record<string, jest.Mock>).push = mockPush;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "user-1" } });
  (useContacts as jest.Mock).mockReturnValue({
    data: [{ contact_user_id: "user-2", full_name: "Bob", balance: 15 }],
  });
  (useDeleteContactExpense as jest.Mock).mockReturnValue({
    mutate: mockDeleteMutate,
  });
  (useDeleteContactPayment as jest.Mock).mockReturnValue({
    mutate: mockDeletePaymentMutate,
  });
  (useSnackbar as jest.Mock).mockReturnValue({ showError: mockShowError });
  (useConfirm as jest.Mock).mockReturnValue(mockConfirm);
  setup();
});

describe("ContactDetail screen", () => {
  it("sets the screen title to the contact name", async () => {
    await renderWithPaper(<ContactDetail />);

    expect(screenOptions().title).toBe("Bob");
  });

  it("uses the name param for the title before the contacts list loads", async () => {
    mockParams.name = "Bob";
    (useContacts as jest.Mock).mockReturnValue({ data: undefined });
    await renderWithPaper(<ContactDetail />);

    expect(screenOptions().title).toBe("Bob");
  });

  it("falls back to 'Contact' when there is no loaded contact or name param", async () => {
    (useContacts as jest.Mock).mockReturnValue({ data: undefined });
    await renderWithPaper(<ContactDetail />);

    expect(screenOptions().title).toBe("Contact");
  });

  it("prefers the loaded contact name over the name param", async () => {
    mockParams.name = "Stale Name";
    await renderWithPaper(<ContactDetail />);

    expect(screenOptions().title).toBe("Bob");
  });

  it("shows the contact owes you when balance is positive", async () => {
    await renderWithPaper(<ContactDetail />);

    expect(screen.getByText("Bob owes you")).toBeTruthy();
    expect(screen.getByText("Dinner")).toBeTruthy();
  });

  it("shows you owe the contact when balance is negative", async () => {
    setup({ balance: -15 });
    await renderWithPaper(<ContactDetail />);

    expect(screen.getByText("You owe Bob")).toBeTruthy();
  });

  it("shows the settled state and empty activity", async () => {
    setup({ balance: 0, expenses: [] });
    await renderWithPaper(<ContactDetail />);

    expect(screen.getByText("You're all settled up")).toBeTruthy();
    expect(screen.getByText("No activity yet")).toBeTruthy();
  });

  it("shows a card per shared group with the pairwise balance", async () => {
    setup({
      groupBreakdown: [
        { group_id: "g1", group_name: "Ski Trip", balance: 40 },
        { group_id: "g2", group_name: "Roomies", balance: -15 },
      ],
    });
    await renderWithPaper(<ContactDetail />);

    expect(screen.getByText("In shared groups")).toBeTruthy();
    expect(screen.getByText("Ski Trip")).toBeTruthy();
    expect(screen.getByText("Bob owes you $40.00")).toBeTruthy();
    expect(screen.getByText("Roomies")).toBeTruthy();
    expect(screen.getByText("You owe $15.00")).toBeTruthy();
  });

  it("navigates to the group when a shared-group card is pressed", async () => {
    setup({
      groupBreakdown: [{ group_id: "g1", group_name: "Ski Trip", balance: 40 }],
    });
    await renderWithPaper(<ContactDetail />);

    await fireEvent.press(screen.getByText("Ski Trip"));

    expect(mockPush).toHaveBeenCalledWith("/group/g1");
  });

  it("navigates to add-expense with the contact id", async () => {
    await renderWithPaper(<ContactDetail />);

    await fireEvent.press(screen.getByText("Add Expense"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/contacts/add-expense",
      params: { contactUserId: "user-2" },
    });
  });

  it("navigates to settle-up with the contact id", async () => {
    await renderWithPaper(<ContactDetail />);

    await fireEvent.press(screen.getByText("Settle Up"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/contacts/settle-up",
      params: { contactUserId: "user-2" },
    });
  });

  it("renders a one-on-one payment and navigates to edit it", async () => {
    setup({ payments: paymentsFixture });
    await renderWithPaper(<ContactDetail />);

    expect(screen.getByText("You paid Bob $20.00")).toBeTruthy();

    await fireEvent.press(screen.getByText("You paid Bob $20.00"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/contacts/settle-up",
      params: { contactUserId: "user-2", paymentId: "cp-1" },
    });
  });

  it("places and dates a payment by its date, not when it was recorded", async () => {
    setup({
      expenses: [{ ...expensesFixture[0], date: new Date(2024, 0, 15, 12).toISOString() }],
      payments: [
        {
          ...paymentsFixture[0],
          created_at: new Date(2023, 11, 1, 12).toISOString(),
          date: new Date(2024, 1, 1, 12).toISOString(),
        },
      ],
    });
    await renderWithPaper(<ContactDetail />);

    const rows = screen
      .getAllByText(/^(You paid Bob \$20\.00|Dinner)$/)
      .map((node) => [node.props.children].flat().join(""));
    expect(rows).toEqual(["You paid Bob $20.00", "Dinner"]);
    expect(screen.getByText("Feb 1")).toBeTruthy();
    expect(screen.queryByText("Dec 1")).toBeNull();
  });

  it("confirms and deletes a one-on-one payment on confirm", async () => {
    setup({ payments: paymentsFixture });
    await renderWithPaper(<ContactDetail />);

    await fireEvent(screen.getByText("You paid Bob $20.00"), "longPress");

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmArg = mockConfirm.mock.calls[0][0];
    expect(confirmArg.title).toBe("Delete Payment");
    expect(confirmArg.destructive).toBe(true);

    await actAsync(async () => {
      confirmArg.onConfirm();
    });

    expect(mockDeletePaymentMutate).toHaveBeenCalledWith(
      { paymentId: "cp-1", contactUserId: "user-2" },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it("confirms and deletes an expense on confirm", async () => {
    await renderWithPaper(<ContactDetail />);

    await fireEvent(screen.getByText("Dinner"), "longPress");

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmArg = mockConfirm.mock.calls[0][0];
    expect(confirmArg.title).toBe("Delete Expense");
    expect(confirmArg.destructive).toBe(true);

    await actAsync(async () => {
      confirmArg.onConfirm();
    });

    expect(mockDeleteMutate).toHaveBeenCalledWith(
      { expenseId: "ce-1", contactUserId: "user-2" },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it("says deleting a repeat's occurrence only removes that one", async () => {
    setup({
      expenses: [
        {
          ...expensesFixture[0],
          schedule_id: "s1",
          occurrence_date: "2024-01-01",
        },
      ],
    });
    await renderWithPaper(<ContactDetail />);

    await fireEvent(screen.getByText("Dinner"), "longPress");

    const confirmArg = mockConfirm.mock.calls[0][0];
    expect(confirmArg.title).toBe("Delete Expense");
    expect(confirmArg.message).toContain(
      "This only removes this one occurrence; the series continues. To stop the series, use Repeating."
    );
  });

  it("does not mention a series when deleting an ordinary expense", async () => {
    await renderWithPaper(<ContactDetail />);

    await fireEvent(screen.getByText("Dinner"), "longPress");

    expect(mockConfirm.mock.calls[0][0].message).not.toMatch(
      /occurrence|series/
    );
  });

  it("opens the contact's Repeating list from the header", async () => {
    await renderWithPaper(<ContactDetail />);

    await actAsync(async () => {
      screenOptions().headerRight?.().props.onPress();
    });

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/repeating",
      params: { contactUserId: "user-2" },
    });
  });

  it("offers no Repeating list for a group-mate who is not a contact", async () => {
    (useContacts as jest.Mock).mockReturnValue({
      data: [
        {
          contact_user_id: "user-2",
          full_name: "Bob",
          balance: 15,
          is_accepted: false,
        },
      ],
    });
    await renderWithPaper(<ContactDetail />);

    expect(screenOptions().headerRight).toBeUndefined();
  });

  it("hides 1-on-1 actions and currency editing for a non-contact group-mate", async () => {
    (useContacts as jest.Mock).mockReturnValue({
      data: [
        {
          contact_user_id: "user-2",
          full_name: "Bob",
          balance: 15,
          is_accepted: false,
        },
      ],
    });
    setup({ expenses: [], groupBreakdown: [{ group_id: "g1", group_name: "Ski Trip", balance: 15 }] });
    await renderWithPaper(<ContactDetail />);

    expect(screen.queryByText("Add Expense")).toBeNull();
    expect(screen.queryByText("Settle Up")).toBeNull();
    expect(
      screen.queryByText("Set the base currency for one-on-one expenses.")
    ).toBeNull();
  });
});

describe("ContactDetail hosted in the Activity tab", () => {
  it("keeps navigation inside the activity stack", async () => {
    setup({
      groupBreakdown: [{ group_id: "g1", group_name: "Ski Trip", balance: 40 }],
    });
    await renderWithPaper(<ActivityContactDetail />);

    await fireEvent.press(screen.getByText("Add Expense"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/activity/contacts/add-expense",
      params: { contactUserId: "user-2" },
    });

    await fireEvent.press(screen.getByText("Settle Up"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/activity/contacts/settle-up",
      params: { contactUserId: "user-2" },
    });

    await fireEvent.press(screen.getByText("Ski Trip"));
    expect(mockPush).toHaveBeenCalledWith("/activity/group/g1");
  });
});


describe("ContactDetail upcoming transactions", () => {
  const NOW = new Date("2026-11-09T12:00:00.000Z");
  const futureExpense = {
    ...expensesFixture[0],
    id: "ce-future",
    description: "Rent",
    date: "2026-12-01T00:00:00.000Z",
  };
  const futurePayment = {
    ...paymentsFixture[0],
    id: "cp-future",
    note: "Scheduled",
    date: "2026-11-20T00:00:00.000Z",
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("lists future-dated expenses and payments under Upcoming, soonest first, each tagged", async () => {
    setup({
      expenses: [futureExpense, ...expensesFixture],
      payments: [futurePayment],
    });
    await renderWithPaper(<ContactDetail />);

    expect(screen.getAllByText("Upcoming")).toHaveLength(3);
    const order = screen
      .getAllByText(/^(Rent|You paid Bob \$20\.00|Dinner)$/)
      .map((node) => [node.props.children].flat().join(""));
    expect(order).toEqual(["You paid Bob $20.00", "Rent", "Dinner"]);
  });

  it("keeps a future row out of the past list and does not show the empty state", async () => {
    setup({ expenses: [futureExpense], payments: [] });
    await renderWithPaper(<ContactDetail />);

    expect(screen.getByText("Rent")).toBeTruthy();
    expect(screen.queryByText("History")).toBeNull();
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  it("shows no Upcoming section when nothing is future-dated", async () => {
    await renderWithPaper(<ContactDetail />);

    expect(screen.queryByText("Upcoming")).toBeNull();
    expect(screen.queryByText("History")).toBeNull();
  });

  it("treats a row dated exactly now as already counting", async () => {
    setup({
      expenses: [],
      payments: [{ ...futurePayment, date: NOW.toISOString() }],
    });
    await renderWithPaper(<ContactDetail />);

    expect(screen.getByText("You paid Bob $20.00")).toBeTruthy();
    expect(screen.queryByText("Upcoming")).toBeNull();
  });

  it("opens an upcoming payment for editing and an upcoming expense for cancelling", async () => {
    setup({ expenses: [futureExpense], payments: [futurePayment] });
    await renderWithPaper(<ContactDetail />);

    await fireEvent.press(screen.getByText("You paid Bob $20.00"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/contacts/settle-up",
      params: { contactUserId: "user-2", paymentId: "cp-future" },
    });

    await fireEvent(screen.getByText("Rent"), "longPress");
    expect(mockConfirm.mock.calls[0][0].title).toBe("Delete Expense");
  });

  it("moves a row out of Upcoming and refetches the balance when its date arrives", async () => {
    const refetchBalance = jest.fn().mockResolvedValue(undefined);
    setup({
      expenses: [
        { ...futureExpense, date: new Date(NOW.getTime() + 10_000).toISOString() },
      ],
      payments: [],
    });
    (useContactBalance as jest.Mock).mockReturnValue({
      data: 15,
      refetch: refetchBalance,
    });
    await renderWithPaper(<ContactDetail />);
    expect(screen.getAllByText("Upcoming")).toHaveLength(2);

    await act(async () => {
      jest.advanceTimersByTime(12_000);
    });

    expect(screen.queryByText("Upcoming")).toBeNull();
    expect(screen.getByText("Rent")).toBeTruthy();
    expect(refetchBalance).toHaveBeenCalled();
  });

  it.each([
    ["expense", "Fresh dinner"],
    ["payment", "You paid Bob $20.00"],
  ])(
    "lists a %s created after minutes on screen as history, with no spurious refetch",
    async (kind, label) => {
      const refetchBalance = jest.fn().mockResolvedValue(undefined);
      const view = await renderWithPaper(<ContactDetail />);

      jest.setSystemTime(new Date(NOW.getTime() + 10 * 60_000));
      const created = new Date(Date.now() - 2_000).toISOString();
      setup(
        kind === "expense"
          ? {
              expenses: [
                { ...futureExpense, id: "fresh", description: "Fresh dinner", date: created },
              ],
              payments: [],
            }
          : { expenses: [], payments: [{ ...futurePayment, id: "fresh", date: created }] }
      );
      (useContactBalance as jest.Mock).mockReturnValue({
        data: 15,
        refetch: refetchBalance,
      });
      await act(async () => {
        await view.rerender(<ContactDetail />);
      });

      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.queryByText("Upcoming")).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(screen.queryByText("Upcoming")).toBeNull();
      expect(refetchBalance).not.toHaveBeenCalled();
    }
  );

  it("starts the timer from an upcoming payment's date", async () => {
    setup({
      expenses: [],
      payments: [
        { ...futurePayment, date: new Date(NOW.getTime() + 10_000).toISOString() },
      ],
    });
    await renderWithPaper(<ContactDetail />);
    expect(screen.getAllByText("Upcoming")).toHaveLength(2);

    await act(async () => {
      jest.advanceTimersByTime(12_000);
    });

    expect(screen.queryByText("Upcoming")).toBeNull();
  });

  it("keeps the pair currency locked while only future rows exist", async () => {
    setup({ expenses: [futureExpense], payments: [] });
    await renderWithPaper(<ContactDetail />);

    expect(
      screen.queryByText("Set the base currency for one-on-one expenses.")
    ).toBeNull();
  });
});
