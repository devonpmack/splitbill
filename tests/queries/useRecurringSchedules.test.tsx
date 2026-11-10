import { renderHook, waitFor } from "@testing-library/react-native";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { actAsync, createWrapper, queryBuilder } from "../helpers/testUtils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import {
  useCreateRecurringSchedule,
  useRecurringSchedules,
  useScheduleFrequencies,
  useStopRecurringSchedule,
} from "@/lib/queries/useRecurringSchedules";

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

function clientWithSpy() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  const spy = jest.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const keys = () => spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  return { wrapper, keys, queryClient };
}

describe("useRecurringSchedules", () => {
  it("reads a group's schedules, newest first", async () => {
    const rows = [{ id: "s1" }];
    const builder = queryBuilder({ data: rows, error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(
      () => useRecurringSchedules({ kind: "group", groupId: "g1" }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockedSupabase.from).toHaveBeenCalledWith("recurring_schedules");
    expect(builder.eq).toHaveBeenCalledWith("group_id", "g1");
    expect(builder.order).toHaveBeenCalledWith("created_at", {
      ascending: false,
    });
  });

  it("reads a contact pair's schedules by the ordered user pair", async () => {
    const builder = queryBuilder({ data: [], error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(
      () => useRecurringSchedules({ kind: "contact", contactUserId: "user-0" }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(builder.eq).toHaveBeenCalledWith("user_lo", "user-0");
    expect(builder.eq).toHaveBeenCalledWith("user_hi", "user-1");
  });

  it("surfaces query errors", async () => {
    mockedSupabase.from.mockReturnValue(
      queryBuilder({ data: null, error: new Error("boom") })
    );

    const { result } = await renderHook(
      () => useRecurringSchedules({ kind: "group", groupId: "g1" }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe("useScheduleFrequencies", () => {
  it("maps each visible schedule id to its frequency and whether it has stopped", async () => {
    const builder = queryBuilder({
      data: [
        { id: "s1", frequency: "monthly", stopped_at: null },
        { id: "s2", frequency: "biweekly", stopped_at: "2026-03-01T00:00:00Z" },
      ],
      error: null,
    });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useScheduleFrequencies(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(builder.select).toHaveBeenCalledWith("id, frequency, stopped_at");
    expect(result.current.data).toEqual({
      s1: { frequency: "monthly", stopped: false },
      s2: { frequency: "biweekly", stopped: true },
    });
  });

  it("is refetched by the ['recurring-schedules'] invalidation", async () => {
    mockedSupabase.from.mockReturnValue(queryBuilder({ data: [], error: null }));
    const { wrapper, queryClient } = clientWithSpy();
    const { result } = await renderHook(() => useScheduleFrequencies(), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.from).toHaveBeenCalledTimes(1);

    await actAsync(async () => {
      await queryClient.invalidateQueries({ queryKey: ["recurring-schedules"] });
    });

    expect(mockedSupabase.from).toHaveBeenCalledTimes(2);
  });
});

const groupInput = {
  scope: { kind: "group", groupId: "g1" } as const,
  paidBy: "user-1",
  amount: 30,
  description: "Rent",
  splitType: "equal" as const,
  splits: [
    { userId: "user-1", amount: 15 },
    { userId: "user-2", amount: 15 },
  ],
  currency: "EUR",
  exchangeRate: 1.1,
  startDate: "2026-11-09",
  timeZone: "America/Toronto",
  frequency: "monthly" as const,
};

describe("useCreateRecurringSchedule", () => {
  it("calls create_recurring_schedule for a group with the exact args", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "s1" }, error: null });
    const { result } = await renderHook(() => useCreateRecurringSchedule(), {
      wrapper: createWrapper(),
    });

    const created = await actAsync(() =>
      result.current.mutateAsync({ ...groupInput, maxCount: 12 })
    );

    expect(created).toEqual({ id: "s1" });
    expect(mockedSupabase.rpc).toHaveBeenCalledTimes(1);
    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "create_recurring_schedule",
      {
        p_group_id: "g1",
        p_contact_id: null,
        p_paid_by: "user-1",
        p_amount: 30,
        p_description: "Rent",
        p_category: null,
        p_split_type: "equal",
        p_splits: [
          { userId: "user-1", amount: 15 },
          { userId: "user-2", amount: 15 },
        ],
        p_currency: "EUR",
        p_exchange_rate: 1.1,
        p_start_date: "2026-11-09",
        p_tz: "America/Toronto",
        p_frequency: "monthly",
        p_end_date: null,
        p_max_count: 12,
      }
    );
  });

  it("calls it for a contact pair with the other person's id and an end date", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "s2" }, error: null });
    const { result } = await renderHook(() => useCreateRecurringSchedule(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        ...groupInput,
        scope: { kind: "contact", contactUserId: "user-2" },
        endDate: "2027-01-01",
      })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "create_recurring_schedule",
      expect.objectContaining({
        p_group_id: null,
        p_contact_id: "user-2",
        p_end_date: "2027-01-01",
        p_max_count: null,
      })
    );
  });

  it("never sends baseAmount and does not call the plain expense RPCs", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "s1" }, error: null });
    const { result } = await renderHook(() => useCreateRecurringSchedule(), {
      wrapper: createWrapper(),
    });

    await actAsync(() => result.current.mutateAsync(groupInput));

    const names = mockedSupabase.rpc.mock.calls.map((c) => c[0]);
    expect(names).toEqual(["create_recurring_schedule"]);
    for (const split of mockedSupabase.rpc.mock.calls[0][1].p_splits) {
      expect(split).not.toHaveProperty("baseAmount");
    }
  });

  it("rejects splits that do not add up, without calling the server", async () => {
    const { result } = await renderHook(() => useCreateRecurringSchedule(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          ...groupInput,
          splits: [{ userId: "user-1", amount: 10 }],
        })
      )
    ).rejects.toThrow("Split amounts must add up to the expense total");
    expect(mockedSupabase.rpc).not.toHaveBeenCalled();
  });

  it("propagates the server's error", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: new Error("End date cannot be before the start date"),
    });
    const { result } = await renderHook(() => useCreateRecurringSchedule(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() => result.current.mutateAsync(groupInput))
    ).rejects.toThrow("End date cannot be before the start date");
  });

  it("invalidates the group's expense and balance queries and the schedules", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "s1" }, error: null });
    const { wrapper, keys } = clientWithSpy();
    const { result } = await renderHook(() => useCreateRecurringSchedule(), {
      wrapper,
    });

    await actAsync(() => result.current.mutateAsync(groupInput));

    for (const key of [
      ["expenses", "g1"],
      ["balances", "g1"],
      ["total-balance"],
      ["activity"],
      ["recurring-schedules"],
    ]) {
      expect(keys()).toContain(JSON.stringify(key));
    }
  });

  it("invalidates the contact pair's queries and the schedules", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "s2" }, error: null });
    const { wrapper, keys } = clientWithSpy();
    const { result } = await renderHook(() => useCreateRecurringSchedule(), {
      wrapper,
    });

    await actAsync(() =>
      result.current.mutateAsync({
        ...groupInput,
        scope: { kind: "contact", contactUserId: "user-2" },
      })
    );

    for (const key of [
      ["contact-expenses", "user-1", "user-2"],
      ["contact-balance", "user-1", "user-2"],
      ["recurring-schedules"],
    ]) {
      expect(keys()).toContain(JSON.stringify(key));
    }
  });
});

describe("useStopRecurringSchedule", () => {
  it("calls stop_recurring_schedule with the id", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "s1" }, error: null });
    const { result } = await renderHook(() => useStopRecurringSchedule(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        scheduleId: "s1",
        scope: { kind: "group", groupId: "g1" },
      })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith("stop_recurring_schedule", {
      p_schedule_id: "s1",
    });
  });

  it("invalidates schedules, the scope's expenses and balances", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "s1" }, error: null });
    const { wrapper, keys } = clientWithSpy();
    const { result } = await renderHook(() => useStopRecurringSchedule(), {
      wrapper,
    });

    await actAsync(() =>
      result.current.mutateAsync({
        scheduleId: "s1",
        scope: { kind: "group", groupId: "g1" },
      })
    );

    for (const key of [
      ["recurring-schedules"],
      ["expenses", "g1"],
      ["balances", "g1"],
      ["activity"],
    ]) {
      expect(keys()).toContain(JSON.stringify(key));
    }
  });

  it("invalidates the contact pair's queries for a contact schedule", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "s1" }, error: null });
    const { wrapper, keys } = clientWithSpy();
    const { result } = await renderHook(() => useStopRecurringSchedule(), {
      wrapper,
    });

    await actAsync(() =>
      result.current.mutateAsync({
        scheduleId: "s1",
        scope: { kind: "contact", contactUserId: "user-2" },
      })
    );

    expect(keys()).toContain(
      JSON.stringify(["contact-expenses", "user-1", "user-2"])
    );
    expect(keys()).toContain(JSON.stringify(["recurring-schedules"]));
  });

  it("propagates the server's error and invalidates nothing", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: new Error("Not authenticated"),
    });
    const { wrapper, keys } = clientWithSpy();
    const { result } = await renderHook(() => useStopRecurringSchedule(), {
      wrapper,
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          scheduleId: "s1",
          scope: { kind: "group", groupId: "g1" },
        })
      )
    ).rejects.toThrow("Not authenticated");
    expect(keys()).toEqual([]);
  });
});
