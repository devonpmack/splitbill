import { screen, fireEvent } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import Activity from "@/app/(tabs)/activity/index";

const mockRefetch = jest.fn();
const mockRefetchPayments = jest.fn();
const mockRefetchContactExpenses = jest.fn();
const mockRefetchContactPayments = jest.fn();
const mockRefetchSimplifyEvents = jest.fn();

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useExpenses", () => ({ useRecentActivity: jest.fn() }));
jest.mock("@/lib/queries/usePayments", () => ({ useRecentPayments: jest.fn() }));
jest.mock("@/lib/queries/useContactExpenses", () => ({
  useRecentContactActivity: jest.fn(),
}));
jest.mock("@/lib/queries/useContactPayments", () => ({
  useRecentContactPayments: jest.fn(),
}));
jest.mock("@/lib/queries/useGroups", () => ({
  useRecentGroupSettingChanges: jest.fn(),
}));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import { useRecentActivity } from "@/lib/queries/useExpenses";
import { useRecentPayments } from "@/lib/queries/usePayments";
import {
  useRecentContactActivity,
} from "@/lib/queries/useContactExpenses";
import {
  useRecentContactPayments,
} from "@/lib/queries/useContactPayments";
import { useRecentGroupSettingChanges } from "@/lib/queries/useGroups";

function setActivity(overrides?: { data?: unknown; isLoading?: boolean }) {
  (useRecentActivity as jest.Mock).mockReturnValue({
    data: overrides?.data ?? [],
    isLoading: overrides?.isLoading ?? false,
    refetch: mockRefetch,
  });
}

function setPayments(overrides?: { data?: unknown; isLoading?: boolean }) {
  (useRecentPayments as jest.Mock).mockReturnValue({
    data: overrides?.data ?? [],
    isLoading: overrides?.isLoading ?? false,
    refetch: mockRefetchPayments,
  });
}

function setContactExpenses(overrides?: {
  data?: unknown;
  isLoading?: boolean;
}) {
  (useRecentContactActivity as jest.Mock).mockReturnValue({
    data: overrides?.data ?? [],
    isLoading: overrides?.isLoading ?? false,
    refetch: mockRefetchContactExpenses,
  });
}

function setContactPayments(overrides?: {
  data?: unknown;
  isLoading?: boolean;
}) {
  (useRecentContactPayments as jest.Mock).mockReturnValue({
    data: overrides?.data ?? [],
    isLoading: overrides?.isLoading ?? false,
    refetch: mockRefetchContactPayments,
  });
}

function setSimplifyEvents(overrides?: {
  data?: unknown;
  isLoading?: boolean;
}) {
  (useRecentGroupSettingChanges as jest.Mock).mockReturnValue({
    data: overrides?.data ?? [],
    isLoading: overrides?.isLoading ?? false,
    refetch: mockRefetchSimplifyEvents,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRefetch.mockResolvedValue(undefined);
  mockRefetchPayments.mockResolvedValue(undefined);
  mockRefetchContactExpenses.mockResolvedValue(undefined);
  mockRefetchContactPayments.mockResolvedValue(undefined);
  mockRefetchSimplifyEvents.mockResolvedValue(undefined);
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "u1" } });
  setActivity();
  setPayments();
  setContactExpenses();
  setContactPayments();
  setSimplifyEvents();
});

describe("Activity screen", () => {
  it("shows the empty state when there is no activity", async () => {
    await renderWithPaper(<Activity />);

    expect(screen.getByText("No recent activity")).toBeTruthy();
    expect(
      screen.getByText("Add expenses or settle up to see activity here")
    ).toBeTruthy();
  });

  it("shows what the current user lent on their own expense", async () => {
    setActivity({
      data: [
        {
          id: "e1",
          description: "Dinner",
          amount: 30,
          paid_by: "u1",
          group_id: "g1",
          payer: { full_name: "Me" },
          groups: { name: "Trip" },
          date: "2024-01-01",
          expense_splits: [
            { user_id: "u1", amount: 10 },
            { user_id: "u2", amount: 20 },
          ],
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("Dinner")).toBeTruthy();
    expect(screen.getByText("You paid $30.00 in Trip")).toBeTruthy();
    expect(screen.getByText("You lent")).toBeTruthy();
    expect(screen.getByText("$20.00")).toBeTruthy();
  });

  it("shows what the current user borrowed on another member's expense", async () => {
    setActivity({
      data: [
        {
          id: "e2",
          description: "Taxi",
          amount: 12,
          paid_by: "u2",
          group_id: "g1",
          payer: { full_name: "Bob" },
          groups: { name: "Trip" },
          date: "2024-01-02",
          expense_splits: [
            { user_id: "u1", amount: 6 },
            { user_id: "u2", amount: 6 },
          ],
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("Bob paid $12.00 in Trip")).toBeTruthy();
    expect(screen.getByText("You borrowed")).toBeTruthy();
    expect(screen.getByText("$6.00")).toBeTruthy();
  });

  it("filters out contact expenses the current user is not involved in", async () => {
    // Group expenses are filtered server-side by get_recent_activity; contact
    // expenses are still filtered here.
    setContactExpenses({
      data: [
        {
          id: "ce3",
          description: "Snacks",
          amount: 5,
          paid_by: "u3",
          payer: null,
          user_lo: "u3",
          user_hi: "u4",
          user_lo_profile: null,
          user_hi_profile: null,
          date: "2024-01-03",
          expense_splits: [{ user_id: "u3", amount: 5 }],
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.queryByText("Snacks")).toBeNull();
    expect(screen.getByText("No recent activity")).toBeTruthy();
  });

  it("shows a payment the current user made to settle a debt", async () => {
    setPayments({
      data: [
        {
          id: "p1",
          amount: 20,
          date: "2024-01-05",
          paid_by: "u1",
          paid_to: "u2",
          group_id: "g1",
          note: null,
          payer: { full_name: "Me" },
          payee: { full_name: "Bob" },
          groups: { name: "Trip" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("You paid Bob")).toBeTruthy();
    expect(screen.getByText("in Trip")).toBeTruthy();
    expect(screen.getByText("$20.00")).toBeTruthy();
  });

  it("dates a payment by its date, not when it was recorded", async () => {
    setPayments({
      data: [
        {
          id: "p1",
          amount: 20,
          created_at: "2023-12-01T12:00:00Z",
          date: "2024-02-01T12:00:00Z",
          paid_by: "u1",
          paid_to: "u2",
          group_id: "g1",
          note: null,
          payer: { full_name: "Me" },
          payee: { full_name: "Bob" },
          groups: { name: "Trip" },
        },
      ],
    });
    setContactPayments({
      data: [
        {
          id: "cp1",
          amount: 5,
          created_at: "2023-11-01T12:00:00Z",
          date: "2024-03-01T12:00:00Z",
          paid_by: "u1",
          paid_to: "u2",
          note: null,
          payer: { full_name: "Me" },
          payee: { full_name: "Bob" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(
      screen.getByText(new Date("2024-02-01T12:00:00Z").toLocaleDateString())
    ).toBeTruthy();
    expect(
      screen.getByText(new Date("2024-03-01T12:00:00Z").toLocaleDateString())
    ).toBeTruthy();
    expect(
      screen.queryByText(new Date("2023-12-01T12:00:00Z").toLocaleDateString())
    ).toBeNull();
  });

  it("shows a payment received by the current user", async () => {
    setPayments({
      data: [
        {
          id: "p2",
          amount: 15,
          date: "2024-01-06",
          paid_by: "u3",
          paid_to: "u1",
          group_id: "g2",
          note: "thanks!",
          payer: { full_name: "Carol" },
          payee: { full_name: "Me" },
          groups: { name: "Lunch" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("Carol paid you")).toBeTruthy();
    expect(screen.getByText("thanks!")).toBeTruthy();
  });

  it("shows a contact expense the current user paid", async () => {
    setContactExpenses({
      data: [
        {
          id: "ce1",
          description: "Movie tickets",
          amount: 24,
          date: "2024-01-07",
          paid_by: "u1",
          user_lo: "u1",
          user_hi: "u2",
          payer: { id: "u1", full_name: "Me" },
          user_lo_profile: { id: "u1", full_name: "Me" },
          user_hi_profile: { id: "u2", full_name: "Bob" },
          expense_splits: [
            { user_id: "u1", amount: 12 },
            { user_id: "u2", amount: 12 },
          ],
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("Movie tickets")).toBeTruthy();
    expect(screen.getByText("You paid $24.00 · with Bob")).toBeTruthy();
    expect(screen.getByText("You lent")).toBeTruthy();
    expect(screen.getByText("$12.00")).toBeTruthy();
  });

  it("labels a contact expense paid by the other person", async () => {
    setContactExpenses({
      data: [
        {
          id: "ce2",
          description: "Groceries",
          amount: 40,
          date: "2024-01-08",
          paid_by: "u2",
          user_lo: "u1",
          user_hi: "u2",
          payer: { id: "u2", full_name: "Bob" },
          user_lo_profile: { id: "u1", full_name: "Me" },
          user_hi_profile: { id: "u2", full_name: "Bob" },
          expense_splits: [
            { user_id: "u1", amount: 20 },
            { user_id: "u2", amount: 20 },
          ],
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("Bob paid $40.00 · with you")).toBeTruthy();
    expect(screen.getByText("You borrowed")).toBeTruthy();
    expect(screen.getByText("$20.00")).toBeTruthy();
  });

  it("shows a contact payment the current user made", async () => {
    setContactPayments({
      data: [
        {
          id: "cp1",
          amount: 18,
          currency: "USD",
          date: "2024-01-09",
          paid_by: "u1",
          paid_to: "u2",
          note: "rent",
          payer: { id: "u1", full_name: "Me" },
          payee: { id: "u2", full_name: "Bob" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("You paid Bob")).toBeTruthy();
    expect(screen.getByText("rent")).toBeTruthy();
    expect(screen.getByText("$18.00")).toBeTruthy();
  });

  it("shows a contact payment received by the current user", async () => {
    setContactPayments({
      data: [
        {
          id: "cp2",
          amount: 9,
          currency: "USD",
          date: "2024-01-10",
          paid_by: "u3",
          paid_to: "u1",
          note: null,
          payer: { id: "u3", full_name: "Carol" },
          payee: { id: "u1", full_name: "Me" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("Carol paid you")).toBeTruthy();
  });

  it("shows when the current user turned simplify debts on", async () => {
    setSimplifyEvents({
      data: [
        {
          id: "sd1",
          group_id: "g1",
          actor_id: "u1",
          enabled: true,
          created_at: "2024-01-11",
          actor: { id: "u1", full_name: "Me" },
          groups: { name: "Trip" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("You turned on simplify debts")).toBeTruthy();
    expect(screen.getByText("in Trip")).toBeTruthy();
  });

  it("shows when another member turned simplify debts off", async () => {
    setSimplifyEvents({
      data: [
        {
          id: "sd2",
          group_id: "g1",
          actor_id: "u2",
          enabled: false,
          created_at: "2024-01-12",
          actor: { id: "u2", full_name: "Bob" },
          groups: { name: "Trip" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.getByText("Bob turned off simplify debts")).toBeTruthy();
  });

  it("opens the group when a group expense row is tapped", async () => {
    setActivity({
      data: [
        {
          id: "e1",
          description: "Dinner",
          amount: 30,
          paid_by: "u1",
          group_id: "g1",
          payer: { full_name: "Me" },
          groups: { name: "Trip" },
          date: "2024-01-01",
          expense_splits: [{ user_id: "u1", amount: 30 }],
        },
      ],
    });
    await renderWithPaper(<Activity />);

    await fireEvent.press(screen.getByText("Dinner"));
    expect(router.push).toHaveBeenCalledWith("/activity/group/g1");
  });

  it("edits a group expense when its pencil is tapped", async () => {
    setActivity({
      data: [
        {
          id: "e1",
          description: "Dinner",
          amount: 30,
          paid_by: "u1",
          group_id: "g1",
          payer: { full_name: "Me" },
          groups: { name: "Trip" },
          date: "2024-01-01",
          expense_splits: [{ user_id: "u1", amount: 30 }],
        },
      ],
    });
    await renderWithPaper(<Activity />);

    await fireEvent.press(screen.getByLabelText("Edit expense"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/group-add-expense",
      params: { groupId: "g1", expenseId: "e1" },
    });
  });

  it("opens the group when a payment row is tapped", async () => {
    setPayments({
      data: [
        {
          id: "p1",
          amount: 20,
          date: "2024-01-05",
          paid_by: "u1",
          paid_to: "u2",
          group_id: "g1",
          note: null,
          payer: { full_name: "Me" },
          payee: { full_name: "Bob" },
          groups: { name: "Trip" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    await fireEvent.press(screen.getByText("You paid Bob"));
    expect(router.push).toHaveBeenCalledWith("/activity/group/g1");
  });

  it("edits a payment when its pencil is tapped", async () => {
    setPayments({
      data: [
        {
          id: "p1",
          amount: 20,
          date: "2024-01-05",
          paid_by: "u1",
          paid_to: "u2",
          group_id: "g1",
          note: null,
          payer: { full_name: "Me" },
          payee: { full_name: "Bob" },
          groups: { name: "Trip" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    await fireEvent.press(screen.getByLabelText("Edit payment"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/group-edit-payment",
      params: { groupId: "g1", paymentId: "p1" },
    });
  });

  it("opens the contact and edits a contact expense", async () => {
    setContactExpenses({
      data: [
        {
          id: "ce1",
          description: "Movie tickets",
          amount: 24,
          date: "2024-01-07",
          paid_by: "u1",
          user_lo: "u1",
          user_hi: "u2",
          payer: { id: "u1", full_name: "Me" },
          user_lo_profile: { id: "u1", full_name: "Me" },
          user_hi_profile: { id: "u2", full_name: "Bob" },
          expense_splits: [
            { user_id: "u1", amount: 12 },
            { user_id: "u2", amount: 12 },
          ],
        },
      ],
    });
    await renderWithPaper(<Activity />);

    await fireEvent.press(screen.getByText("Movie tickets"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/activity/contacts/[id]",
      params: { id: "u2", name: "Bob" },
    });

    await fireEvent.press(screen.getByLabelText("Edit expense"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/activity/contacts/add-expense",
      params: { contactUserId: "u2", expenseId: "ce1" },
    });
  });

  it("opens the contact and edits a contact payment", async () => {
    setContactPayments({
      data: [
        {
          id: "cp1",
          amount: 18,
          currency: "USD",
          date: "2024-01-09",
          paid_by: "u1",
          paid_to: "u2",
          note: "rent",
          payer: { id: "u1", full_name: "Me" },
          payee: { id: "u2", full_name: "Bob" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    await fireEvent.press(screen.getByText("You paid Bob"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/activity/contacts/[id]",
      params: { id: "u2", name: "Bob" },
    });

    await fireEvent.press(screen.getByLabelText("Edit payment"));
    expect(router.push).toHaveBeenCalledWith({
      pathname: "/activity/contacts/settle-up",
      params: { contactUserId: "u2", paymentId: "cp1" },
    });
  });

  it("navigates to the group from a simplify-debts row and shows no edit control", async () => {
    setSimplifyEvents({
      data: [
        {
          id: "sd1",
          group_id: "g1",
          actor_id: "u1",
          enabled: true,
          created_at: "2024-01-11",
          actor: { id: "u1", full_name: "Me" },
          groups: { name: "Trip" },
        },
      ],
    });
    await renderWithPaper(<Activity />);

    expect(screen.queryByLabelText("Edit expense")).toBeNull();
    expect(screen.queryByLabelText("Edit payment")).toBeNull();
    await fireEvent.press(screen.getByText("You turned on simplify debts"));
    expect(router.push).toHaveBeenCalledWith("/activity/group/g1");
  });

});
