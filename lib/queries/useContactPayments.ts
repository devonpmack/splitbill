import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../supabase";
import type {
  ActivityContactPayment,
  ContactPaymentWithProfiles,
} from "../types";
import { useAuth } from "../auth";
import { invalidateContactPairQueries } from "./invalidate";
import { sortPair } from "./contact-pair";

export function useRecentContactPayments() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["contact-payments-activity", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contact_payments")
        .select(
          `
          id,
          amount,
          currency,
          date,
          paid_by,
          paid_to,
          note,
          payer:profiles!contact_payments_paid_by_fkey (*),
          payee:profiles!contact_payments_paid_to_fkey (*)
        `
        )
        .order("date", { ascending: false })
        .limit(50);

      if (error) throw error;
      return data as unknown as ActivityContactPayment[];
    },
    enabled: !!user,
  });
}

export function useContactPayments(contactUserId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["contact-payments", user?.id, contactUserId],
    queryFn: async () => {
      const [lo, hi] = sortPair(user!.id, contactUserId);

      const { data, error } = await supabase
        .from("contact_payments")
        .select(
          `
          *,
          payer:profiles!contact_payments_paid_by_fkey (*),
          payee:profiles!contact_payments_paid_to_fkey (*)
        `
        )
        .eq("user_lo", lo)
        .eq("user_hi", hi)
        .order("date", { ascending: false });

      if (error) throw error;
      return data as unknown as ContactPaymentWithProfiles[];
    },
    enabled: !!user && !!contactUserId,
  });
}

interface CreateContactPaymentInput {
  contactUserId: string;
  paidBy: string;
  paidTo: string;
  amount: number;
  note?: string;
  currency?: string;
  // Start of the picked local day; omitted for today (create) or an unchanged
  // day (edit), so the server defaults to now() or keeps the stored date.
  date?: string;
}

export function useCreateContactPayment() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateContactPaymentInput) => {
      // The RPC sorts the participant pair, checks the two are accepted
      // contacts, and derives currency and base_amount from the pair setting.
      const { data, error } = await supabase.rpc("create_contact_payment", {
        p_contact_user_id: input.contactUserId,
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
      invalidateContactPairQueries(
        queryClient,
        user?.id,
        variables.contactUserId
      );
    },
  });
}

interface UpdateContactPaymentInput extends CreateContactPaymentInput {
  paymentId: string;
}

export function useUpdateContactPayment() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (input: UpdateContactPaymentInput) => {
      // base_amount is recomputed server-side from the booked rate.
      const { data, error } = await supabase.rpc("update_contact_payment", {
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
      invalidateContactPairQueries(
        queryClient,
        user?.id,
        variables.contactUserId
      );
    },
  });
}

export function useDeleteContactPayment() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      paymentId,
    }: {
      paymentId: string;
      contactUserId: string;
    }) => {
      const { error } = await supabase.rpc("delete_contact_payment", {
        p_payment_id: paymentId,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_, variables) => {
      invalidateContactPairQueries(
        queryClient,
        user?.id,
        variables.contactUserId
      );
    },
  });
}
