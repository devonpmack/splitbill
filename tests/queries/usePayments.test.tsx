import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient } from "@tanstack/react-query";
import { actAsync, createWrapper, queryBuilder } from "../helpers/testUtils";
import { supabase } from "@/lib/supabase";
import {
  useCreatePayment,
  useDeletePayment,
  useGroupPayments,
  useUpdatePayment,
} from "@/lib/queries/usePayments";

jest.mock("@/lib/supabase", () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));

const mockedSupabase = supabase as unknown as {
  from: jest.Mock;
  rpc: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useGroupPayments", () => {
  it("fetches payments for a group with both profile joins, filtered and ordered", async () => {
    const payments = [{ id: "p1" }, { id: "p2" }];
    const builder = queryBuilder({ data: payments, error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useGroupPayments("g1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(mockedSupabase.from).toHaveBeenCalledWith("payments");
    expect(builder.select).toHaveBeenCalledWith(
      expect.stringContaining("payer:profiles!payments_paid_by_fkey")
    );
    expect(builder.select).toHaveBeenCalledWith(
      expect.stringContaining("payee:profiles!payments_paid_to_fkey")
    );
    expect(builder.eq).toHaveBeenCalledWith("group_id", "g1");
    expect(builder.order).toHaveBeenCalledWith("date", {
      ascending: false,
    });
    expect(result.current.data).toEqual(payments);
  });

  it("does not run the query without a group id", async () => {
    const builder = queryBuilder({ data: [], error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useGroupPayments(""), {
      wrapper: createWrapper(),
    });

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("propagates query errors", async () => {
    const builder = queryBuilder({ data: null, error: new Error("boom") });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useGroupPayments("g1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(new Error("boom"));
  });
});

describe("useCreatePayment", () => {
  it("records a payment through the RPC with null note and date defaults", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "p1" }, error: null });

    const { result } = await renderHook(() => useCreatePayment(), {
      wrapper: createWrapper(),
    });

    const created = await actAsync(() =>
      result.current.mutateAsync({
        groupId: "g1",
        paidBy: "u1",
        paidTo: "u2",
        amount: 5,
      })
    );

    expect(created).toEqual({ id: "p1" });
    // Currency and base_amount are derived server-side from the group, so the
    // client no longer sends them.
    expect(mockedSupabase.rpc).toHaveBeenCalledWith("create_payment", {
      p_group_id: "g1",
      p_paid_by: "u1",
      p_paid_to: "u2",
      p_amount: 5,
      p_note: null,
      p_currency: null,
      p_date: null,
    });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("sends the picked date when one is given", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "p1" }, error: null });

    const { result } = await renderHook(() => useCreatePayment(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        groupId: "g1",
        paidBy: "u1",
        paidTo: "u2",
        amount: 5,
        date: "2026-11-12T00:00:00-05:00",
      })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "create_payment",
      expect.objectContaining({ p_date: "2026-11-12T00:00:00-05:00" })
    );
  });

  it("propagates RPC errors", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "You can only record payments you are part of" },
    });

    const { result } = await renderHook(() => useCreatePayment(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          groupId: "g1",
          paidBy: "u1",
          paidTo: "u2",
          amount: 5,
        })
      )
    ).rejects.toThrow("You can only record payments you are part of");
  });
});

describe("useUpdatePayment", () => {
  it("edits a payment through the RPC", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "p1" }, error: null });

    const { result } = await renderHook(() => useUpdatePayment(), {
      wrapper: createWrapper(),
    });

    const updated = await actAsync(() =>
      result.current.mutateAsync({
        paymentId: "p1",
        groupId: "g1",
        paidBy: "u2",
        paidTo: "u1",
        amount: 7,
        note: "venmo",
      })
    );

    expect(updated).toEqual({ id: "p1" });
    // base_amount is recomputed server-side from the booked rate.
    expect(mockedSupabase.rpc).toHaveBeenCalledWith("update_payment", {
      p_payment_id: "p1",
      p_paid_by: "u2",
      p_paid_to: "u1",
      p_amount: 7,
      p_note: "venmo",
      p_date: null,
    });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("sends the picked date when one is given", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "p1" }, error: null });

    const { result } = await renderHook(() => useUpdatePayment(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        paymentId: "p1",
        groupId: "g1",
        paidBy: "u2",
        paidTo: "u1",
        amount: 7,
        date: "2026-11-12T00:00:00-05:00",
      })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "update_payment",
      expect.objectContaining({ p_date: "2026-11-12T00:00:00-05:00" })
    );
  });

  it("propagates RPC errors", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "You can only edit payments you are part of" },
    });

    const { result } = await renderHook(() => useUpdatePayment(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          paymentId: "p1",
          groupId: "g1",
          paidBy: "u2",
          paidTo: "u1",
          amount: 7,
        })
      )
    ).rejects.toThrow("You can only edit payments you are part of");
  });

  it("invalidates the group pairwise roster so it live-refreshes on edit", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "p1" }, error: null });
    const invalidateSpy = jest.spyOn(
      QueryClient.prototype,
      "invalidateQueries"
    );

    const { result } = await renderHook(() => useUpdatePayment(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        paymentId: "p1",
        groupId: "g1",
        paidBy: "u1",
        paidTo: "u2",
        amount: 7,
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

describe("useDeletePayment", () => {
  it("deletes through the RPC by payment id", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: null, error: null });

    const { result } = await renderHook(() => useDeletePayment(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({ paymentId: "p1", groupId: "g1" })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith("delete_payment", {
      p_payment_id: "p1",
    });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("rejects when the RPC refuses the delete", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "You are not a member of this group" },
    });

    const { result } = await renderHook(() => useDeletePayment(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({ paymentId: "p1", groupId: "g1" })
      )
    ).rejects.toThrow("You are not a member of this group");
  });
});
