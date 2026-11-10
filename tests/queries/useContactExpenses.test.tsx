import { renderHook, waitFor } from "@testing-library/react-native";
import {
  actAsync,
  createWrapper,
  freezeNow,
  queryBuilder,
} from "../helpers/testUtils";
import React from "react";
import { UPCOMING_OVERLAP_MS } from "@/lib/upcoming";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";

import {
  useContactExpenses,
  useRecentContactActivity,
  useUpcomingContactActivity,
  useCreateContactExpense,
  useUpdateContactExpense,
  useDeleteContactExpense,
} from "@/lib/queries/useContactExpenses";

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
  mockedUseAuth.mockReturnValue({ user: { id: "user-1", email: "me@x.com" } });
});

describe("useContactExpenses", () => {
  it("queries the normalized participant pair ordered by date", async () => {
    const rows = [{ id: "ce-1" }];
    const builder = queryBuilder({ data: rows, error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useContactExpenses("user-2"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.from).toHaveBeenCalledWith("contact_expenses");
    expect(builder.eq).toHaveBeenCalledWith("user_lo", "user-1");
    expect(builder.eq).toHaveBeenCalledWith("user_hi", "user-2");
    expect(builder.order).toHaveBeenCalledWith("date", { ascending: false });
    expect(result.current.data).toEqual(rows);
  });

  it("sorts the pair regardless of which id is larger", async () => {
    mockedUseAuth.mockReturnValue({ user: { id: "user-9" } });
    const builder = queryBuilder({ data: [], error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useContactExpenses("user-2"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(builder.eq).toHaveBeenCalledWith("user_lo", "user-2");
    expect(builder.eq).toHaveBeenCalledWith("user_hi", "user-9");
  });
});

describe("useCreateContactExpense", () => {
  it("rejects when split amounts do not add up to the total", async () => {
    const { result } = await renderHook(() => useCreateContactExpense(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          contactUserId: "user-2",
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

  it("calls create_contact_expense_with_splits with mapped params", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "ce-1" }, error: null });

    const { result } = await renderHook(() => useCreateContactExpense(), {
      wrapper: createWrapper(),
    });

    const created = await actAsync(() =>
      result.current.mutateAsync({
        contactUserId: "user-2",
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

    expect(created).toEqual({ id: "ce-1" });
    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "create_contact_expense_with_splits",
      {
        p_contact_user_id: "user-2",
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

});

describe("useUpdateContactExpense", () => {

  it("calls update_contact_expense_with_splits with mapped params", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "ce-1" }, error: null });

    const { result } = await renderHook(() => useUpdateContactExpense(), {
      wrapper: createWrapper(),
    });

    const updated = await actAsync(() =>
      result.current.mutateAsync({
        expenseId: "ce-1",
        contactUserId: "user-2",
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

    expect(updated).toEqual({ id: "ce-1" });
    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "update_contact_expense_with_splits",
      {
        p_expense_id: "ce-1",
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
});

describe("useDeleteContactExpense", () => {
  it("deletes the contact expense through the RPC", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: null, error: null });

    const { result } = await renderHook(() => useDeleteContactExpense(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({ expenseId: "ce1", contactUserId: "user-2" })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith("delete_contact_expense", {
      p_expense_id: "ce1",
    });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("rejects when the RPC refuses the delete", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "You are not a participant in this expense" },
    });

    const { result } = await renderHook(() => useDeleteContactExpense(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({ expenseId: "ce1", contactUserId: "user-2" })
      )
    ).rejects.toThrow("You are not a participant in this expense");
  });
});

describe("useRecentContactActivity and useUpcomingContactActivity split the feed at now", () => {
  const NOW = new Date("2026-11-09T12:00:00.000Z");

  beforeEach(() => freezeNow(NOW));
  afterEach(() => jest.useRealTimers());

  it("useRecentContactActivity reads only rows dated at or before now", async () => {
    const builder = queryBuilder({ data: [], error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useRecentContactActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.from).toHaveBeenCalledWith("contact_expenses");
    expect(builder.lte).toHaveBeenCalledWith("date", NOW.toISOString());
    expect(builder.gt).not.toHaveBeenCalled();
    expect(builder.order).toHaveBeenCalledWith("date", { ascending: false });
  });

  it("a row dated between the two reads' own clock readings is in at least one of them", async () => {
    const recentBuilder = queryBuilder({ data: [], error: null });
    const upcomingBuilder = queryBuilder({ data: [], error: null });

    mockedSupabase.from.mockReturnValue(recentBuilder);
    const recent = await renderHook(() => useRecentContactActivity(), { wrapper: createWrapper() });
    await waitFor(() => expect(recent.result.current.isSuccess).toBe(true));

    // The upcoming read runs 30 s after the recent one.
    jest.setSystemTime(NOW.getTime() + 30_000);
    mockedSupabase.from.mockReturnValue(upcomingBuilder);
    const upcoming = await renderHook(() => useUpcomingContactActivity(), { wrapper: createWrapper() });
    await waitFor(() => expect(upcoming.result.current.isSuccess).toBe(true));

    const recentUpTo = new Date(recentBuilder.lte.mock.calls[0][1]).getTime();
    const upcomingAfter = new Date(upcomingBuilder.gt.mock.calls[0][1]).getTime();
    expect(upcomingAfter).toBeLessThan(recentUpTo);
  });

  it("useUpcomingContactActivity reads only rows dated after now, soonest first", async () => {
    const rows = [{ id: "r1" }];
    const builder = queryBuilder({ data: rows, error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useUpcomingContactActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockedSupabase.from).toHaveBeenCalledWith("contact_expenses");
    expect(builder.select).toHaveBeenCalledWith(
      expect.stringMatching(/^\s*id,[\s\S]*\bdate,/)
    );
    expect(builder.gt).toHaveBeenCalledWith(
      "date",
      new Date(NOW.getTime() - UPCOMING_OVERLAP_MS).toISOString()
    );
    expect(builder.lte).not.toHaveBeenCalled();
    expect(builder.order).toHaveBeenCalledWith("date", { ascending: true });
    expect(builder.limit).toHaveBeenCalledWith(50);
  });

  it("useUpcomingContactActivity surfaces query errors", async () => {
    mockedSupabase.from.mockReturnValue(
      queryBuilder({ data: null, error: new Error("boom") })
    );

    const { result } = await renderHook(() => useUpcomingContactActivity(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("useUpcomingContactActivity is refetched by the ['contact-activity'] invalidation every write issues", async () => {
    const builder = queryBuilder({ data: [], error: null });
    mockedSupabase.from.mockReturnValue(builder);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = await renderHook(() => useUpcomingContactActivity(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.from).toHaveBeenCalledTimes(1);

    await actAsync(async () => {
      await queryClient.invalidateQueries({ queryKey: ["contact-activity"] });
    });

    expect(mockedSupabase.from).toHaveBeenCalledTimes(2);
  });
});
