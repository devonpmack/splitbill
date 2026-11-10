import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../supabase";
import type {
  ActivityPayment,
  PaymentWithProfiles,
} from "../types";
import { useAuth } from "../auth";
import { invalidateGroupQueries } from "./invalidate";

const ACTIVITY_LIMIT = 50;
const ACTIVITY_PAYMENT_SELECT = `
          id,
          amount,
          currency,
          date,
          paid_by,
          paid_to,
          group_id,
          note,
          payer:profiles!payments_paid_by_fkey (*),
          payee:profiles!payments_paid_to_fkey (*),
          groups (name)
        `;

export function useRecentPayments() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["activity-payments", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select(ACTIVITY_PAYMENT_SELECT)
        .lte("date", new Date().toISOString())
        .order("date", { ascending: false })
        .limit(ACTIVITY_LIMIT);

      if (error) throw error;
      return data as unknown as ActivityPayment[];
    },
    enabled: !!user,
  });
}

// Future-dated rows, soonest first; the recent read above leaves them out so
// they cannot take its 50 slots. The key sits under the recent key's prefix, so
// every activity invalidation covers it too.
export function useUpcomingPayments() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["activity-payments", user?.id, "upcoming"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select(ACTIVITY_PAYMENT_SELECT)
        .gt("date", new Date().toISOString())
        .order("date", { ascending: true })
        .limit(ACTIVITY_LIMIT);

      if (error) throw error;
      return data as unknown as ActivityPayment[];
    },
    enabled: !!user,
  });
}

export function useGroupPayments(groupId: string) {
  return useQuery({
    queryKey: ["payments", groupId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("payments")
        .select(
          `
          *,
          payer:profiles!payments_paid_by_fkey (*),
          payee:profiles!payments_paid_to_fkey (*)
        `
        )
        .eq("group_id", groupId)
        .order("date", { ascending: false });

      if (error) throw error;
      return data as unknown as PaymentWithProfiles[];
    },
    enabled: !!groupId,
  });
}

interface CreatePaymentInput {
  groupId: string;
  paidBy: string;
  paidTo: string;
  amount: number;
  note?: string;
  currency?: string;
  // Start of the picked local day; omitted for today (create) or an unchanged
  // day (edit), so the server defaults to now() or keeps the stored date.
  date?: string;
}

export function useCreatePayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreatePaymentInput) => {
      // Settle-up is recorded in the group's base currency at a rate of 1; the
      // RPC derives currency and base_amount from the group rather than
      // trusting them from here.
      const { data, error } = await supabase.rpc("create_payment", {
        p_group_id: input.groupId,
        p_paid_by: input.paidBy,
        p_paid_to: input.paidTo,
        p_amount: input.amount,
        p_note: input.note ?? null,
        p_currency: input.currency ?? null,
        p_date: input.date ?? null,
      });

      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (_, variables) => {
      invalidateGroupQueries(queryClient, variables.groupId);
    },
  });
}

interface UpdatePaymentInput {
  paymentId: string;
  groupId: string;
  paidBy: string;
  paidTo: string;
  amount: number;
  note?: string;
  date?: string;
}

export function useUpdatePayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdatePaymentInput) => {
      // base_amount is recomputed server-side from the rate the payment was
      // booked at, so an edit cannot leave the converted amount out of step.
      const { data, error } = await supabase.rpc("update_payment", {
        p_payment_id: input.paymentId,
        p_paid_by: input.paidBy,
        p_paid_to: input.paidTo,
        p_amount: input.amount,
        p_note: input.note ?? null,
        p_date: input.date ?? null,
      });

      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: (_, variables) => {
      invalidateGroupQueries(queryClient, variables.groupId);
    },
  });
}

export function useDeletePayment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      paymentId,
    }: {
      paymentId: string;
      groupId: string;
    }) => {
      const { error } = await supabase.rpc("delete_payment", {
        p_payment_id: paymentId,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_, variables) => {
      invalidateGroupQueries(queryClient, variables.groupId);
    },
  });
}
