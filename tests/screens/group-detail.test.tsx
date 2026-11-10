import { act, fireEvent, screen } from "@testing-library/react-native";
import { renderWithPaper, actAsync } from "../helpers/testUtils";
import GroupDetail from "@/app/(tabs)/groups/[id]";

const mockPush = jest.fn();
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockCanGoBack = jest.fn();
// Captures whatever Stack.Screen was handed, so a test can assert the
// header options the screen set.
type HeaderElement = {
  props: { onLeave: () => void; onSettings: () => void };
};
type ScreenOptions = { title?: string; headerRight: () => HeaderElement };
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

const mockDeleteMutate = jest.fn();
const mockDeletePaymentMutate = jest.fn();
const mockLeaveAsync = jest.fn();
const mockShowError = jest.fn();
const mockShowInfo = jest.fn();
const mockConfirm = jest.fn();
const mockRefetchGroup = jest.fn();
const mockRefetchExpenses = jest.fn();
const mockRefetchPayments = jest.fn();
const mockRefetchBalances = jest.fn();

jest.mock("expo-router", () => ({
  router: {
    push: jest.fn(),
    back: jest.fn(),
    replace: jest.fn(),
    canGoBack: jest.fn(),
  },
  useLocalSearchParams: () => ({ id: "g1" }),
  Stack: {
    Screen: (props: { options: ScreenOptions }) => {
      mockScreenHolder.options = props.options;
      return null;
    },
  },
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useGroups", () => ({
  useGroup: jest.fn(),
  useLeaveGroup: jest.fn(),
}));
jest.mock("@/lib/queries/useExpenses", () => ({
  useExpenses: jest.fn(),
  useDeleteExpense: jest.fn(),
}));
jest.mock("@/lib/queries/usePayments", () => ({
  useGroupPayments: jest.fn(),
  useDeletePayment: jest.fn(),
}));
jest.mock("@/lib/queries/useBalances", () => ({
  useGroupBalances: jest.fn(),
  useGroupPairwiseBalances: jest.fn(),
  useGroupSimplifiedEdges: jest.fn(),
}));
jest.mock("@/lib/realtime", () => ({ useRealtimeSubscription: jest.fn() }));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));
jest.mock("@/lib/confirm", () => ({ useConfirm: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import { useGroup, useLeaveGroup } from "@/lib/queries/useGroups";
import { useExpenses, useDeleteExpense } from "@/lib/queries/useExpenses";
import { useGroupPayments, useDeletePayment } from "@/lib/queries/usePayments";
import {
  useGroupBalances,
  useGroupPairwiseBalances,
  useGroupSimplifiedEdges,
} from "@/lib/queries/useBalances";
import { useSnackbar } from "@/lib/snackbar";
import { useConfirm } from "@/lib/confirm";

const group = { id: "g1", name: "Trip" };
const expensesFixture = [
  {
    id: "e1",
    description: "Dinner",
    amount: 30,
    paid_by: "u1",
    payer: { full_name: "Me" },
    date: "2024-01-01",
    expense_splits: [
      { id: "s1", user_id: "u1", amount: 15, profiles: { full_name: "Me" } },
      { id: "s2", user_id: "u2", amount: 15, profiles: { full_name: "Bob" } },
    ],
  },
];
const paymentsFixture = [
  {
    id: "p1",
    amount: 20,
    paid_by: "u1",
    paid_to: "u2",
    payer: { full_name: "Me" },
    payee: { full_name: "Bob" },
    note: "Venmo transfer",
    created_at: "2024-01-02",
    date: "2024-01-02",
  },
];
const owingBalances = [
  { user_id: "u1", full_name: "Me", balance: -15 },
  { user_id: "u2", full_name: "Bob", balance: 15 },
];

function setup(overrides?: {
  expenses?: unknown;
  payments?: unknown;
  balances?: unknown;
  group?: unknown;
  simplifiedEdges?: unknown;
}) {
  (useGroup as jest.Mock).mockReturnValue({
    data: overrides?.group ?? group,
    refetch: mockRefetchGroup,
  });
  (useExpenses as jest.Mock).mockReturnValue({
    data: overrides && "expenses" in overrides ? overrides.expenses : expensesFixture,
    refetch: mockRefetchExpenses,
  });
  (useGroupPayments as jest.Mock).mockReturnValue({
    data: overrides && "payments" in overrides ? overrides.payments : [],
    refetch: mockRefetchPayments,
  });
  (useGroupBalances as jest.Mock).mockReturnValue({
    data: overrides && "balances" in overrides ? overrides.balances : owingBalances,
    refetch: mockRefetchBalances,
  });
  (useGroupPairwiseBalances as jest.Mock).mockReturnValue({
    data: [],
    refetch: jest.fn(),
  });
  (useGroupSimplifiedEdges as jest.Mock).mockReturnValue({
    data:
      overrides && "simplifiedEdges" in overrides
        ? overrides.simplifiedEdges
        : [],
    refetch: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockScreenHolder.options = null;
  mockLeaveAsync.mockResolvedValue(undefined);
  mockCanGoBack.mockReturnValue(true);
  mockRefetchGroup.mockResolvedValue(undefined);
  mockRefetchExpenses.mockResolvedValue(undefined);
  mockRefetchPayments.mockResolvedValue(undefined);
  mockRefetchBalances.mockResolvedValue(undefined);
  (router as unknown as Record<string, jest.Mock>).push = mockPush;
  (router as unknown as Record<string, jest.Mock>).back = mockBack;
  (router as unknown as Record<string, jest.Mock>).replace = mockReplace;
  (router as unknown as Record<string, jest.Mock>).canGoBack = mockCanGoBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "u1" } });
  (useLeaveGroup as jest.Mock).mockReturnValue({ mutateAsync: mockLeaveAsync });
  (useDeleteExpense as jest.Mock).mockReturnValue({ mutate: mockDeleteMutate });
  (useDeletePayment as jest.Mock).mockReturnValue({
    mutate: mockDeletePaymentMutate,
  });
  (useSnackbar as jest.Mock).mockReturnValue({
    showError: mockShowError,
    showInfo: mockShowInfo,
  });
  (useConfirm as jest.Mock).mockReturnValue(mockConfirm);
  setup();
});

function pressLeave() {
  screenOptions().headerRight().props.onLeave();
}

function pressSettings() {
  screenOptions().headerRight().props.onSettings();
}

describe("GroupDetail screen", () => {
  it("renders the expenses tab with the user's personal stake", async () => {
    await renderWithPaper(<GroupDetail />);

    expect(screen.getByText("Dinner")).toBeTruthy();
    expect(screen.getByText("You paid $30.00")).toBeTruthy();
    expect(screen.getByText("You lent")).toBeTruthy();
    expect(screen.getByText("$15.00")).toBeTruthy();
  });

  it("shows what the user owes when someone else paid", async () => {
    setup({
      expenses: [
        {
          ...expensesFixture[0],
          paid_by: "u2",
          payer: { full_name: "Bob" },
        },
      ],
      payments: [],
    });
    await renderWithPaper(<GroupDetail />);

    expect(screen.getByText("Bob paid $30.00")).toBeTruthy();
    expect(screen.getByText("You borrowed")).toBeTruthy();
    expect(screen.getByText("$15.00")).toBeTruthy();
  });

  it("shows the empty state when there is no activity", async () => {
    setup({ expenses: [], payments: [] });
    await renderWithPaper(<GroupDetail />);

    expect(screen.getByText("No activity yet")).toBeTruthy();
  });

  it("renders debt payments in the activity feed, differentiated from expenses", async () => {
    setup({ expenses: [], payments: paymentsFixture });
    await renderWithPaper(<GroupDetail />);

    expect(screen.getByText("You paid Bob $20.00")).toBeTruthy();
    expect(screen.getByText("Venmo transfer")).toBeTruthy();
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
    await renderWithPaper(<GroupDetail />);

    const rows = screen
      .getAllByText(/^(You paid Bob \$20\.00|Dinner)$/)
      .map((node) => [node.props.children].flat().join(""));
    expect(rows).toEqual(["You paid Bob $20.00", "Dinner"]);
    expect(screen.getByText("Feb 1")).toBeTruthy();
    expect(screen.queryByText("Dec 1")).toBeNull();
  });

  it("asks for confirmation and deletes a payment on confirm", async () => {
    setup({ expenses: [], payments: paymentsFixture });
    await renderWithPaper(<GroupDetail />);

    await fireEvent(screen.getByText("You paid Bob $20.00"), "longPress");

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmArg = mockConfirm.mock.calls[0][0];
    expect(confirmArg.title).toBe("Delete Payment");
    expect(confirmArg.destructive).toBe(true);

    await actAsync(async () => {
      confirmArg.onConfirm();
    });

    expect(mockDeletePaymentMutate).toHaveBeenCalledWith(
      { paymentId: "p1", groupId: "g1" },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it("switches to the balances tab and shows a per-member balance accordion", async () => {
    setup({
      simplifiedEdges: [
        {
          from: "u1",
          from_name: "Me",
          to: "u2",
          to_name: "Bob",
          amount: 15,
        },
      ],
    });
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("Balances"));

    expect(screen.getByText("Me")).toBeTruthy();
    expect(screen.getByText("owes overall")).toBeTruthy();
    expect(screen.getByText("Bob")).toBeTruthy();
    expect(screen.getByText("is owed overall")).toBeTruthy();

    await fireEvent.press(screen.getByText("Me"));

    expect(screen.getByText("$15.00")).toBeTruthy();
  });

  it("renders the member roster with simplified pairwise balances above the tabs", async () => {
    // Net balances (Bob owes, Me is owed, Carol settled) drive the simplified
    // edge Bob -> Me, which the members card derives its per-person amounts from.
    setup({
      group: {
        id: "g1",
        name: "Trip",
        group_members: [
          { user_id: "u1", profiles: { full_name: "Me" } },
          { user_id: "u2", profiles: { full_name: "Bob" } },
          { user_id: "u3", profiles: { full_name: "Carol" } },
        ],
      },
      expenses: [],
      payments: [],
      balances: [
        { user_id: "u1", full_name: "Me", balance: 15 },
        { user_id: "u2", full_name: "Bob", balance: -15 },
        { user_id: "u3", full_name: "Carol", balance: 0 },
      ],
      simplifiedEdges: [
        {
          from: "u2",
          from_name: "Bob",
          to: "u1",
          to_name: "Me",
          amount: 15,
        },
      ],
    });
    await renderWithPaper(<GroupDetail />);

    expect(screen.getByText("Members (3)")).toBeTruthy();
    expect(screen.getByText("Me (You)")).toBeTruthy();
    expect(screen.getByText("owes you $15.00")).toBeTruthy();
    expect(screen.getByText("settled up")).toBeTruthy();
  });

  it("re-routes the members card through a middleman when debts are simplified", async () => {
    // Vivian owes Bob, Bob owes Me. Net: Vivian -15, Bob 0, Me +15.
    // Simplified, Bob (the middleman) drops out and Vivian owes Me directly,
    // so the members card should show "owes you" for Vivian and "settled up"
    // for the middleman Bob.
    setup({
      group: {
        id: "g1",
        name: "Trip",
        group_members: [
          { user_id: "u1", profiles: { full_name: "Me" } },
          { user_id: "u2", profiles: { full_name: "Bob" } },
          { user_id: "u3", profiles: { full_name: "Vivian" } },
        ],
      },
      expenses: [],
      payments: [],
      balances: [
        { user_id: "u1", full_name: "Me", balance: 15 },
        { user_id: "u2", full_name: "Bob", balance: 0 },
        { user_id: "u3", full_name: "Vivian", balance: -15 },
      ],
      simplifiedEdges: [
        {
          from: "u3",
          from_name: "Vivian",
          to: "u1",
          to_name: "Me",
          amount: 15,
        },
      ],
    });
    await renderWithPaper(<GroupDetail />);

    expect(screen.getByText("Vivian")).toBeTruthy();
    expect(screen.getByText("owes you $15.00")).toBeTruthy();
    expect(screen.getByText("settled up")).toBeTruthy();
  });

  it("navigates to add-members from the members card", async () => {
    setup({
      group: {
        id: "g1",
        name: "Trip",
        group_members: [
          { user_id: "u1", profiles: { full_name: "Me" } },
          { user_id: "u2", profiles: { full_name: "Bob" } },
        ],
      },
    });
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("Add"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/group-add-members",
      params: { groupId: "g1" },
    });
  });

  it("navigates to the manage screen from the settings header action", async () => {
    await renderWithPaper(<GroupDetail />);

    await actAsync(async () => {
      pressSettings();
    });

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/group-manage",
      params: { groupId: "g1" },
    });
  });

  it("shows the all-settled state when there are no balances", async () => {
    setup({ balances: [], simplifiedEdges: [] });
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("Balances"));

    expect(screen.getByText("All settled up!")).toBeTruthy();
  });

  it("does not claim all-settled while the balances are loading", async () => {
    setup({ balances: undefined, simplifiedEdges: [] });
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("Balances"));

    expect(screen.queryByText("All settled up!")).toBeNull();
  });

  it("navigates to add-expense and settle-up with the group id", async () => {
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("Add Expense"));
    await fireEvent.press(screen.getByText("Settle Up"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/group-add-expense",
      params: { groupId: "g1" },
    });
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/group-settle-up",
      params: { groupId: "g1" },
    });
  });

  it("blocks leaving when the user has an outstanding balance", async () => {
    await renderWithPaper(<GroupDetail />);

    await actAsync(async () => {
      pressLeave();
    });

    expect(mockShowInfo).toHaveBeenCalledWith(
      "You have an outstanding balance in this group. Settle up before leaving."
    );
    expect(mockConfirm).not.toHaveBeenCalled();
  });

  it("does not leave while the balance is still loading", async () => {
    setup({ balances: undefined });
    await renderWithPaper(<GroupDetail />);

    await actAsync(async () => {
      pressLeave();
    });

    expect(mockShowInfo).toHaveBeenCalledWith(
      "Still checking your balance. Try again in a moment."
    );
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockLeaveAsync).not.toHaveBeenCalled();
  });

  it("confirms and leaves the group when settled, going back if possible", async () => {
    setup({ balances: [{ user_id: "u1", full_name: "Me", balance: 0 }] });
    await renderWithPaper(<GroupDetail />);

    await actAsync(async () => {
      pressLeave();
    });

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmArg = mockConfirm.mock.calls[0][0];
    expect(confirmArg.title).toBe("Leave Group");
    expect(confirmArg.destructive).toBe(true);

    await actAsync(async () => {
      await confirmArg.onConfirm();
    });

    expect(mockLeaveAsync).toHaveBeenCalledWith("g1");
    expect(mockBack).toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("replaces the route when leaving and there is no back stack", async () => {
    mockCanGoBack.mockReturnValue(false);
    setup({ balances: [{ user_id: "u1", full_name: "Me", balance: 0 }] });
    await renderWithPaper(<GroupDetail />);

    await actAsync(async () => {
      pressLeave();
    });
    const confirmArg = mockConfirm.mock.calls[0][0];

    await actAsync(async () => {
      await confirmArg.onConfirm();
    });

    expect(mockReplace).toHaveBeenCalledWith("/(tabs)/groups");
    expect(mockBack).not.toHaveBeenCalled();
  });

  it("surfaces an error when leaving the group fails", async () => {
    mockLeaveAsync.mockRejectedValue({});
    setup({ balances: [{ user_id: "u1", full_name: "Me", balance: 0 }] });
    await renderWithPaper(<GroupDetail />);

    await actAsync(async () => {
      pressLeave();
    });
    const confirmArg = mockConfirm.mock.calls[0][0];

    await actAsync(async () => {
      await confirmArg.onConfirm();
    });

    expect(mockShowError).toHaveBeenCalledWith(
      "Couldn't leave the group. Please try again."
    );
  });

  it("asks for confirmation and deletes an expense on confirm", async () => {
    await renderWithPaper(<GroupDetail />);

    await fireEvent(screen.getByText("Dinner"), "longPress");

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    const confirmArg = mockConfirm.mock.calls[0][0];
    expect(confirmArg.title).toBe("Delete Expense");
    expect(confirmArg.destructive).toBe(true);

    await actAsync(async () => {
      confirmArg.onConfirm();
    });

    expect(mockDeleteMutate).toHaveBeenCalledWith(
      { expenseId: "e1", groupId: "g1" },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it("navigates to edit an expense when its card is pressed", async () => {
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("Dinner"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/group-add-expense",
      params: { groupId: "g1", expenseId: "e1" },
    });
  });

  it("navigates to edit a payment when its card is pressed", async () => {
    setup({ expenses: [], payments: paymentsFixture });
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("You paid Bob $20.00"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/group-edit-payment",
      params: { groupId: "g1", paymentId: "p1" },
    });
  });

  it("lets a non-payer delete an expense they did not create", async () => {
    setup({
      expenses: [
        {
          ...expensesFixture[0],
          id: "e2",
          paid_by: "u2",
          payer: { full_name: "Bob" },
        },
      ],
      payments: [],
    });
    await renderWithPaper(<GroupDetail />);

    await fireEvent(screen.getByText("Dinner"), "longPress");

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    await actAsync(async () => {
      mockConfirm.mock.calls[0][0].onConfirm();
    });

    expect(mockDeleteMutate).toHaveBeenCalledWith(
      { expenseId: "e2", groupId: "g1" },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });

  it("lets a non-payer delete a payment they did not create", async () => {
    setup({
      expenses: [],
      payments: [
        {
          ...paymentsFixture[0],
          id: "p2",
          paid_by: "u2",
          paid_to: "u1",
          payer: { full_name: "Bob" },
          payee: { full_name: "Me" },
        },
      ],
    });
    await renderWithPaper(<GroupDetail />);

    await fireEvent(screen.getByText("Bob paid you $20.00"), "longPress");

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    await actAsync(async () => {
      mockConfirm.mock.calls[0][0].onConfirm();
    });

    expect(mockDeletePaymentMutate).toHaveBeenCalledWith(
      { paymentId: "p2", groupId: "g1" },
      expect.objectContaining({ onError: expect.any(Function) })
    );
  });
});

describe("GroupDetail upcoming transactions", () => {
  const NOW = new Date("2026-11-09T12:00:00.000Z");
  const futureExpense = {
    ...expensesFixture[0],
    id: "e-future",
    description: "Rent",
    date: "2026-12-01T00:00:00.000Z",
  };
  const soonerPayment = {
    ...paymentsFixture[0],
    id: "p-future",
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
      payments: [soonerPayment],
    });
    await renderWithPaper(<GroupDetail />);

    // Section heading plus one tag per upcoming row.
    expect(screen.getAllByText("Upcoming")).toHaveLength(3);
    const order = screen
      .getAllByText(/^(Rent|You paid Bob \$20\.00|Dinner)$/)
      .map((node) => [node.props.children].flat().join(""));
    expect(order).toEqual(["You paid Bob $20.00", "Rent", "Dinner"]);
    expect(screen.getByText("History")).toBeTruthy();
  });

  it("keeps a future row out of the past list", async () => {
    setup({ expenses: [futureExpense], payments: [] });
    await renderWithPaper(<GroupDetail />);

    expect(screen.getByText("Rent")).toBeTruthy();
    expect(screen.queryByText("History")).toBeNull();
    expect(screen.queryByText("No activity yet")).toBeNull();
  });

  it("shows no Upcoming section when nothing is future-dated", async () => {
    await renderWithPaper(<GroupDetail />);

    expect(screen.queryByText("Upcoming")).toBeNull();
    expect(screen.queryByText("History")).toBeNull();
    expect(screen.getByText("Dinner")).toBeTruthy();
  });

  it("treats a row dated exactly now as already counting", async () => {
    setup({
      expenses: [{ ...futureExpense, date: NOW.toISOString() }],
      payments: [],
    });
    await renderWithPaper(<GroupDetail />);

    expect(screen.getByText("Rent")).toBeTruthy();
    expect(screen.queryByText("Upcoming")).toBeNull();
  });

  it("opens an upcoming expense for editing and offers to cancel it", async () => {
    setup({ expenses: [futureExpense], payments: [] });
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("Rent"));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/group-add-expense",
      params: { groupId: "g1", expenseId: "e-future" },
    });

    await fireEvent(screen.getByText("Rent"), "longPress");
    expect(mockConfirm.mock.calls[0][0].title).toBe("Delete Expense");
  });

  it("opens an upcoming payment for editing", async () => {
    setup({ expenses: [], payments: [soonerPayment] });
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("You paid Bob $20.00"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/group-edit-payment",
      params: { groupId: "g1", paymentId: "p-future" },
    });
  });

  it("moves a row out of Upcoming and refetches balances when its date arrives", async () => {
    setup({
      expenses: [
        { ...futureExpense, date: new Date(NOW.getTime() + 10_000).toISOString() },
      ],
      payments: [],
    });
    await renderWithPaper(<GroupDetail />);
    expect(screen.getAllByText("Upcoming")).toHaveLength(2);
    mockRefetchBalances.mockClear();

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });

    expect(screen.queryByText("Upcoming")).toBeNull();
    expect(screen.getByText("Rent")).toBeTruthy();
    expect(mockRefetchBalances).toHaveBeenCalled();
    expect(mockRefetchExpenses).toHaveBeenCalled();
  });

  it("starts the timer from an upcoming payment's date", async () => {
    setup({
      expenses: [],
      payments: [
        { ...soonerPayment, date: new Date(NOW.getTime() + 10_000).toISOString() },
      ],
    });
    await renderWithPaper(<GroupDetail />);
    expect(screen.getAllByText("Upcoming")).toHaveLength(2);

    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });

    expect(screen.queryByText("Upcoming")).toBeNull();
  });

  it("leaves balances to the server: a future expense does not change them", async () => {
    setup({ expenses: [futureExpense], payments: [], balances: [] });
    await renderWithPaper(<GroupDetail />);

    await fireEvent.press(screen.getByText("Balances"));

    expect(screen.getByText("All settled up!")).toBeTruthy();
  });
});
