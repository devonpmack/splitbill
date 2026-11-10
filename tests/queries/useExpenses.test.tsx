import { renderHook, waitFor } from "@testing-library/react-native";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { actAsync, createWrapper, queryBuilder } from "../helpers/testUtils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import {
  useCreateExpense,
  useDeleteExpense,
  useExpenses,
  useRecentActivity,
  useUpcomingActivity,
  useUpdateExpense,
} from "@/lib/queries/useExpenses";

jest.mock("@/lib/supabase", () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));

const mockedSupabase = supabase as unknown as {
  from: jest.Mock;
  rpc: jest.Mock;
};
const mockedUseAuth = useAuth as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { id: "user-1" } });
});

describe("useRecentActivity", () => {
  it("fetches the caller's involved expenses through the RPC", async () => {
    const rows = [{ id: "exp-1", description: "Lunch" }];
    mockedSupabase.rpc.mockResolvedValue({ data: rows, error: null });

    const { result } = await renderHook(() => useRecentActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    // The involvement predicate has to run before the row cap, so the limit is
    // applied by the RPC rather than by a client-side filter.
    expect(mockedSupabase.rpc).toHaveBeenCalledWith("get_recent_activity", {
      p_limit: 50,
    });
  });

  it("surfaces query errors", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: new Error("boom"),
    });

    const { result } = await renderHook(() => useRecentActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("boom"));
  });
});

describe("useUpcomingActivity", () => {
  it("fetches the caller's future-dated expenses through the RPC", async () => {
    const rows = [{ id: "exp-2", description: "Rent" }];
    mockedSupabase.rpc.mockResolvedValue({ data: rows, error: null });

    const { result } = await renderHook(() => useUpcomingActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockedSupabase.rpc).toHaveBeenCalledWith("get_upcoming_expenses", {
      p_limit: 50,
    });
  });

  it("is refetched by the ['activity'] invalidation every write already issues", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: [], error: null });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = await renderHook(() => useUpcomingActivity(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.rpc).toHaveBeenCalledTimes(1);

    await actAsync(async () => {
      await queryClient.invalidateQueries({ queryKey: ["activity"] });
    });

    expect(mockedSupabase.rpc).toHaveBeenCalledTimes(2);
  });

  it("surfaces query errors", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: new Error("boom"),
    });

    const { result } = await renderHook(() => useUpcomingActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useExpenses", () => {
  it("fetches expenses for a group ordered by date", async () => {
    const rows = [{ id: "exp-1" }];
    const builder = queryBuilder({ data: rows, error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useExpenses("g1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(builder.eq).toHaveBeenCalledWith("group_id", "g1");
    expect(builder.order).toHaveBeenCalledWith("date", { ascending: false });
  });

});

describe("useCreateExpense", () => {
  it("rejects when split amounts do not add up to the total", async () => {
    const { result } = await renderHook(() => useCreateExpense(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          groupId: "g1",
          paidBy: "user-1",
          amount: 10,
          description: "Lunch",
          splitType: "equal",
          splits: [
            { userId: "user-1", amount: 4 },
            { userId: "user-2", amount: 4 },
          ],
        })
      )
    ).rejects.toThrow("Split amounts must add up to the expense total");

    expect(mockedSupabase.rpc).not.toHaveBeenCalled();
  });

  it("calls the create_expense_with_splits RPC with mapped params", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "exp-1" }, error: null });

    const { result } = await renderHook(() => useCreateExpense(), {
      wrapper: createWrapper(),
    });

    const created = await actAsync(() =>
      result.current.mutateAsync({
        groupId: "g1",
        paidBy: "user-1",
        amount: 10,
        description: "Lunch",
        category: "food",
        splitType: "equal",
        splits: [
          { userId: "user-1", amount: 5 },
          { userId: "user-2", amount: 5 },
        ],
      })
    );

    expect(created).toEqual({ id: "exp-1" });
    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "create_expense_with_splits",
      {
        p_group_id: "g1",
        p_paid_by: "user-1",
        p_amount: 10,
        p_description: "Lunch",
        p_category: "food",
        p_split_type: "equal",
        p_splits: [
          { userId: "user-1", amount: 5, baseAmount: 5 },
          { userId: "user-2", amount: 5, baseAmount: 5 },
        ],
        p_date: null,
        p_currency: "USD",
        p_exchange_rate: 1,
      }
    );
  });

  it("converts splits to a base currency when a rate is supplied", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "exp-2" }, error: null });

    const { result } = await renderHook(() => useCreateExpense(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        groupId: "g1",
        paidBy: "user-1",
        amount: 10,
        description: "Lunch",
        splitType: "equal",
        splits: [
          { userId: "user-1", amount: 6 },
          { userId: "user-2", amount: 4 },
        ],
        currency: "EUR",
        exchangeRate: 1.1,
      })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "create_expense_with_splits",
      expect.objectContaining({
        p_currency: "EUR",
        p_exchange_rate: 1.1,
        // 10 * 1.1 = 11 base; splits 6.6 + 4.4 = 11
        p_splits: [
          { userId: "user-1", amount: 6, baseAmount: 6.6 },
          { userId: "user-2", amount: 4, baseAmount: 4.4 },
        ],
      })
    );
  });

  it("propagates RPC errors", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: new Error("rpc failed"),
    });

    const { result } = await renderHook(() => useCreateExpense(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          groupId: "g1",
          paidBy: "user-1",
          amount: 10,
          description: "Lunch",
          splitType: "equal",
          splits: [{ userId: "user-1", amount: 10 }],
        })
      )
    ).rejects.toThrow("rpc failed");
  });
});

describe("useUpdateExpense", () => {
  it("calls the update_expense_with_splits RPC with mapped params", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "exp-1" }, error: null });

    const { result } = await renderHook(() => useUpdateExpense(), {
      wrapper: createWrapper(),
    });

    const updated = await actAsync(() =>
      result.current.mutateAsync({
        expenseId: "exp-1",
        groupId: "g1",
        paidBy: "user-2",
        amount: 10,
        description: "Dinner",
        splitType: "equal",
        splits: [
          { userId: "user-1", amount: 5 },
          { userId: "user-2", amount: 5 },
        ],
      })
    );

    expect(updated).toEqual({ id: "exp-1" });
    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "update_expense_with_splits",
      {
        p_expense_id: "exp-1",
        p_paid_by: "user-2",
        p_amount: 10,
        p_description: "Dinner",
        p_category: null,
        p_split_type: "equal",
        p_splits: [
          { userId: "user-1", amount: 5, baseAmount: 5 },
          { userId: "user-2", amount: 5, baseAmount: 5 },
        ],
        p_date: null,
        p_currency: "USD",
        p_exchange_rate: 1,
      }
    );
  });

  it("invalidates the group pairwise roster so it live-refreshes on edit", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "exp-1" }, error: null });
    const invalidateSpy = jest.spyOn(
      QueryClient.prototype,
      "invalidateQueries"
    );

    const { result } = await renderHook(() => useUpdateExpense(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        expenseId: "exp-1",
        groupId: "g1",
        paidBy: "user-1",
        amount: 10,
        description: "Lunch",
        splitType: "equal",
        splits: [{ userId: "user-1", amount: 10 }],
      })
    );

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["group-pairwise-all", "g1"],
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["group-simplified", "g1"],
    });
    invalidateSpy.mockRestore();
  });
});

describe("useDeleteExpense", () => {
  it("deletes through the RPC by expense id", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: null, error: null });

    const { result } = await renderHook(() => useDeleteExpense(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({ expenseId: "exp-1", groupId: "g1" })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith("delete_expense", {
      p_expense_id: "exp-1",
    });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("rejects when the RPC refuses the delete", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "You are not a member of this group" },
    });

    const { result } = await renderHook(() => useDeleteExpense(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({ expenseId: "exp-1", groupId: "g1" })
      )
    ).rejects.toThrow("You are not a member of this group");
  });
});
