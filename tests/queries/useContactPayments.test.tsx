import { renderHook, waitFor } from "@testing-library/react-native";
import {
  actAsync,
  createWrapper,
  freezeNow,
  queryBuilder,
} from "../helpers/testUtils";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";

import {
  useContactPayments,
  useRecentContactPayments,
  useUpcomingContactPayments,
  useCreateContactPayment,
  useUpdateContactPayment,
  useDeleteContactPayment,
} from "@/lib/queries/useContactPayments";

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

describe("useRecentContactPayments", () => {
  it("selects each payment's date and orders the feed by it, newest first", async () => {
    const builder = queryBuilder({ data: [], error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useRecentContactPayments(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.from).toHaveBeenCalledWith("contact_payments");
    expect(builder.select).toHaveBeenCalledWith(
      expect.stringMatching(/^\s*id,[\s\S]*\bdate,/)
    );
    expect(builder.order).toHaveBeenCalledWith("date", { ascending: false });
    expect(builder.order).toHaveBeenCalledTimes(1);
  });
});

describe("useContactPayments", () => {
  it("queries the normalized participant pair ordered by date", async () => {
    const rows = [{ id: "cp-1" }];
    const builder = queryBuilder({ data: rows, error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useContactPayments("user-2"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.from).toHaveBeenCalledWith("contact_payments");
    expect(builder.eq).toHaveBeenCalledWith("user_lo", "user-1");
    expect(builder.eq).toHaveBeenCalledWith("user_hi", "user-2");
    expect(builder.order).toHaveBeenCalledWith("date", {
      ascending: false,
    });
    expect(result.current.data).toEqual(rows);
  });
});

describe("useCreateContactPayment", () => {
  it("records a payment through the RPC", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "cp1" }, error: null });

    const { result } = await renderHook(() => useCreateContactPayment(), {
      wrapper: createWrapper(),
    });

    const created = await actAsync(() =>
      result.current.mutateAsync({
        contactUserId: "user-2",
        paidBy: "user-1",
        paidTo: "user-2",
        amount: 20,
      })
    );

    expect(created).toEqual({ id: "cp1" });
    // Sorting the pair, checking the contact is accepted, and deriving the
    // currency all happen server-side now.
    expect(mockedSupabase.rpc).toHaveBeenCalledWith("create_contact_payment", {
      p_contact_user_id: "user-2",
      p_paid_by: "user-1",
      p_paid_to: "user-2",
      p_amount: 20,
      p_note: null,
      p_currency: null,
      p_date: null,
    });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("sends the picked date when one is given", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "cp1" }, error: null });

    const { result } = await renderHook(() => useCreateContactPayment(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        contactUserId: "user-2",
        paidBy: "user-1",
        paidTo: "user-2",
        amount: 20,
        date: "2026-11-12T00:00:00-05:00",
      })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "create_contact_payment",
      expect.objectContaining({ p_date: "2026-11-12T00:00:00-05:00" })
    );
  });

  it("rejects a payment with someone who is not an accepted contact", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "You can only record payments with accepted contacts" },
    });

    const { result } = await renderHook(() => useCreateContactPayment(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          contactUserId: "user-9",
          paidBy: "user-1",
          paidTo: "user-9",
          amount: 20,
        })
      )
    ).rejects.toThrow("You can only record payments with accepted contacts");
  });
});

describe("useUpdateContactPayment", () => {
  it("edits the payment through the RPC", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "cp1" }, error: null });

    const { result } = await renderHook(() => useUpdateContactPayment(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        paymentId: "cp1",
        contactUserId: "user-2",
        paidBy: "user-2",
        paidTo: "user-1",
        amount: 12,
        note: "cash",
      })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith("update_contact_payment", {
      p_payment_id: "cp1",
      p_paid_by: "user-2",
      p_paid_to: "user-1",
      p_amount: 12,
      p_note: "cash",
      p_date: null,
    });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("sends the picked date when one is given", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: { id: "cp1" }, error: null });

    const { result } = await renderHook(() => useUpdateContactPayment(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({
        paymentId: "cp1",
        contactUserId: "user-2",
        paidBy: "user-2",
        paidTo: "user-1",
        amount: 12,
        date: "2026-11-12T00:00:00-05:00",
      })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "update_contact_payment",
      expect.objectContaining({ p_date: "2026-11-12T00:00:00-05:00" })
    );
  });

  it("rejects an edit from someone outside the pair", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "You are not a participant in this payment" },
    });

    const { result } = await renderHook(() => useUpdateContactPayment(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({
          paymentId: "cp1",
          contactUserId: "user-2",
          paidBy: "user-2",
          paidTo: "user-1",
          amount: 12,
        })
      )
    ).rejects.toThrow("You are not a participant in this payment");
  });
});

describe("useDeleteContactPayment", () => {
  it("deletes the contact payment through the RPC", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: null, error: null });

    const { result } = await renderHook(() => useDeleteContactPayment(), {
      wrapper: createWrapper(),
    });

    await actAsync(() =>
      result.current.mutateAsync({ paymentId: "cp1", contactUserId: "user-2" })
    );

    expect(mockedSupabase.rpc).toHaveBeenCalledWith("delete_contact_payment", {
      p_payment_id: "cp1",
    });
    expect(mockedSupabase.from).not.toHaveBeenCalled();
  });

  it("rejects when the RPC refuses the delete", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: null,
      error: { message: "You are not a participant in this payment" },
    });

    const { result } = await renderHook(() => useDeleteContactPayment(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() =>
        result.current.mutateAsync({ paymentId: "cp1", contactUserId: "user-2" })
      )
    ).rejects.toThrow("You are not a participant in this payment");
  });
});

describe("useRecentContactPayments and useUpcomingContactPayments split the feed at now", () => {
  const NOW = new Date("2026-11-09T12:00:00.000Z");

  beforeEach(() => freezeNow(NOW));
  afterEach(() => jest.useRealTimers());

  it("useRecentContactPayments reads only rows dated at or before now", async () => {
    const builder = queryBuilder({ data: [], error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useRecentContactPayments(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.from).toHaveBeenCalledWith("contact_payments");
    expect(builder.lte).toHaveBeenCalledWith("date", NOW.toISOString());
    expect(builder.gt).not.toHaveBeenCalled();
    expect(builder.order).toHaveBeenCalledWith("date", { ascending: false });
  });

  it("useUpcomingContactPayments reads only rows dated after now, soonest first", async () => {
    const rows = [{ id: "r1" }];
    const builder = queryBuilder({ data: rows, error: null });
    mockedSupabase.from.mockReturnValue(builder);

    const { result } = await renderHook(() => useUpcomingContactPayments(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(rows);
    expect(mockedSupabase.from).toHaveBeenCalledWith("contact_payments");
    expect(builder.select).toHaveBeenCalledWith(
      expect.stringMatching(/^\s*id,[\s\S]*\bdate,/)
    );
    expect(builder.gt).toHaveBeenCalledWith("date", NOW.toISOString());
    expect(builder.lte).not.toHaveBeenCalled();
    expect(builder.order).toHaveBeenCalledWith("date", { ascending: true });
    expect(builder.limit).toHaveBeenCalledWith(50);
  });

  it("useUpcomingContactPayments surfaces query errors", async () => {
    mockedSupabase.from.mockReturnValue(
      queryBuilder({ data: null, error: new Error("boom") })
    );

    const { result } = await renderHook(() => useUpcomingContactPayments(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it("useUpcomingContactPayments is refetched by the ['contact-payments-activity'] invalidation every write issues", async () => {
    const builder = queryBuilder({ data: [], error: null });
    mockedSupabase.from.mockReturnValue(builder);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = await renderHook(() => useUpcomingContactPayments(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.from).toHaveBeenCalledTimes(1);

    await actAsync(async () => {
      await queryClient.invalidateQueries({ queryKey: ["contact-payments-activity"] });
    });

    expect(mockedSupabase.from).toHaveBeenCalledTimes(2);
  });
});
