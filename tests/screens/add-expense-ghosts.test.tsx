import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import AddExpense from "@/app/group-add-expense";

const mockMutateAsync = jest.fn();
const mockUpdateMutateAsync = jest.fn();
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
  useScheduleFrequencies: () => ({ data: {} }),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));
// The real picker's Menu mounts through a Portal (see add-expense-repeat.test), so
// stand in a plain list of who the payer picker was given.
jest.mock("@/components/groups/PaidByPicker", () => {
  const { Text } = jest.requireActual("react-native");
  return {
    PaidByPicker: ({
      members,
      getMemberName,
    }: {
      members: { user_id: string }[];
      getMemberName: (m: { user_id: string }) => string;
    }) => (
      <>
        {members.map((m) => (
          <Text key={m.user_id} testID="payer-option">
            {getMemberName(m)}
          </Text>
        ))}
      </>
    ),
  };
});
const payerOptions = () => screen.queryAllByTestId("payer-option").map((n) => n.props.children);

import { useAuth } from "@/lib/auth";
import { useGroup } from "@/lib/queries/useGroups";
import {
  useCreateExpense,
  useExpenses,
  useUpdateExpense,
} from "@/lib/queries/useExpenses";
import { useSnackbar } from "@/lib/snackbar";

// The first render in a file loads react-native-paper cold, which can pass the
// default 5 s when the machine is busy.
jest.setTimeout(20000);

// Cara deleted her account: her profile row stays (her name is hidden by the
// server as "Deleted user") and carries deleted_at.
const group = {
  id: "g1",
  name: "Trip",
  group_members: [
    { user_id: "u1", profiles: { full_name: "Me", deleted_at: null } },
    { user_id: "u2", profiles: { full_name: "Bob", deleted_at: null } },
    {
      user_id: "u3",
      profiles: { full_name: "Deleted user", deleted_at: "2026-11-01T00:00:00Z" },
    },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.groupId = "g1";
  mockParams.expenseId = undefined;
  mockMutateAsync.mockResolvedValue({ id: "exp-1" });
  mockUpdateMutateAsync.mockResolvedValue({ id: "exp-1" });
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
  (useSnackbar as jest.Mock).mockReturnValue({ showError: jest.fn() });
});

describe("AddExpense with a member who deleted their account", () => {
  it("leaves them out of the default equal split", async () => {
    await renderWithPaper(<AddExpense />);

    await fireEvent.changeText(
      screen.getByPlaceholderText("What was this expense for?"),
      "Dinner"
    );
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "30");
    await fireEvent.press(screen.getByText("Add Expense"));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        splits: [
          { userId: "u1", amount: 15 },
          { userId: "u2", amount: 15 },
        ],
      })
    );
  });

  it("does not offer them in the split list or as the payer", async () => {
    await renderWithPaper(<AddExpense />);

    expect(screen.queryByText("Deleted user")).toBeNull();
    expect(payerOptions()).toEqual(["Me", "Bob"]);
  });

  describe("editing an expense that does not involve them", () => {
    it("still hides them", async () => {
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
      await renderWithPaper(<AddExpense />);
      await fireEvent.press(screen.getByText("Save Changes"));

      expect(screen.queryByText("Deleted user")).toBeNull();
      await waitFor(() =>
        expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            splits: [
              { userId: "u1", amount: 15 },
              { userId: "u2", amount: 15 },
            ],
          })
        )
      );
    });
  });

  describe("editing an expense where they are only the payer", () => {
    it("keeps them as payer but does not offer them in the split", async () => {
      mockParams.expenseId = "exp-1";
      (useExpenses as jest.Mock).mockReturnValue({
        data: [
          {
            id: "exp-1",
            description: "Old dinner",
            amount: 30,
            paid_by: "u3",
            split_type: "exact",
            expense_splits: [
              { user_id: "u1", amount: 10 },
              { user_id: "u2", amount: 20 },
            ],
          },
        ],
      });
      await renderWithPaper(<AddExpense />);

      expect(payerOptions()).toContain("Deleted user");
      // The payer option is the only place the name shows: no split row.
      expect(screen.getAllByText("Deleted user")).toHaveLength(1);

      await fireEvent.press(screen.getByText("Save Changes"));
      await waitFor(() =>
        expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            paidBy: "u3",
            splits: [
              { userId: "u1", amount: 10 },
              { userId: "u2", amount: 20 },
            ],
          })
        )
      );
    });
  });

  describe("editing an expense where they are only in the split", () => {
    it("keeps them in the split but does not offer them as payer", async () => {
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
              { user_id: "u3", amount: 15 },
            ],
          },
        ],
      });
      await renderWithPaper(<AddExpense />);

      // A split row shows them; the payer picker is not offered them.
      expect(screen.getAllByText("Deleted user")).toHaveLength(1);
      expect(payerOptions()).toEqual(["Me", "Bob"]);
    });
  });

  describe("editing an expense that already involves them", () => {
    beforeEach(() => {
      mockParams.expenseId = "exp-1";
      (useExpenses as jest.Mock).mockReturnValue({
        data: [
          {
            id: "exp-1",
            description: "Old dinner",
            amount: 30,
            paid_by: "u3",
            split_type: "equal",
            expense_splits: [
              { user_id: "u1", amount: 15 },
              { user_id: "u3", amount: 15 },
            ],
          },
        ],
      });
    });

    it("keeps them by name as payer and in the split", async () => {
      await renderWithPaper(<AddExpense />);

      expect(payerOptions()).toContain("Deleted user");
      expect(screen.getAllByText("Deleted user")).toHaveLength(2); // payer + split row

      await fireEvent.press(screen.getByText("Save Changes"));

      await waitFor(() =>
        expect(mockUpdateMutateAsync).toHaveBeenCalledTimes(1)
      );
      expect(mockUpdateMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          paidBy: "u3",
          splits: [
            { userId: "u1", amount: 15 },
            { userId: "u3", amount: 15 },
          ],
        })
      );
    });
  });
});
