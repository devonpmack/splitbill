import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../supabase";
import type {
  ActivityContactExpense,
  ContactExpenseWithSplits,
  SplitType,
} from "../types";
import { useAuth } from "../auth";
import { UPCOMING_OVERLAP_MS } from "../upcoming";
import { getCurrencyDecimals } from "../currency";
import { buildSplitsPayload, validateSplitsTotal } from "../utils";
import { invalidateContactPairQueries } from "./invalidate";
import { sortPair } from "./contact-pair";

const ACTIVITY_LIMIT = 50;
const ACTIVITY_CONTACT_EXPENSE_SELECT = `
          id,
          description,
          amount,
          currency,
          date,
          schedule_id,
          occurrence_date,
          paid_by,
          user_lo,
          user_hi,
          payer:profiles!contact_expenses_paid_by_fkey (*),
          user_lo_profile:profiles!contact_expenses_user_lo_fkey (*),
          user_hi_profile:profiles!contact_expenses_user_hi_fkey (*),
          expense_splits:contact_expense_splits (user_id, amount)
        `;

export function useRecentContactActivity() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["contact-activity", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contact_expenses")
        .select(ACTIVITY_CONTACT_EXPENSE_SELECT)
        .lte("date", new Date().toISOString())
        .order("date", { ascending: false })
        .limit(ACTIVITY_LIMIT);

      if (error) throw error;
      return data as unknown as ActivityContactExpense[];
    },
    enabled: !!user,
  });
}

// Future-dated rows, soonest first; the recent read above leaves them out so
// they cannot take its 50 slots. The key sits under the recent key's prefix, so
// every activity invalidation covers it too. It starts UPCOMING_OVERLAP_MS before
// now so a row dated between the two reads' clock readings is in one of them.
export function useUpcomingContactActivity() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["contact-activity", user?.id, "upcoming"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("contact_expenses")
        .select(ACTIVITY_CONTACT_EXPENSE_SELECT)
        .gt("date", new Date(Date.now() - UPCOMING_OVERLAP_MS).toISOString())
        .order("date", { ascending: true })
        .limit(ACTIVITY_LIMIT);

      if (error) throw error;
      return data as unknown as ActivityContactExpense[];
    },
    enabled: !!user,
  });
}

export function useContactExpenses(contactUserId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["contact-expenses", user?.id, contactUserId],
    queryFn: async () => {
      const [lo, hi] = sortPair(user!.id, contactUserId);

      const { data, error } = await supabase
        .from("contact_expenses")
        .select(
          `
          *,
          payer:profiles!contact_expenses_paid_by_fkey (*),
          expense_splits:contact_expense_splits (
            *,
            profiles (*)
          )
        `
        )
        .eq("user_lo", lo)
        .eq("user_hi", hi)
        .order("date", { ascending: false });

      if (error) throw error;
      return data as unknown as ContactExpenseWithSplits[];
    },
    enabled: !!user && !!contactUserId,
  });
}

interface CreateContactExpenseInput {
  contactUserId: string;
  paidBy: string;
  amount: number;
  description: string;
  category?: string;
  splitType: SplitType;
  splits: { userId: string; amount: number }[];
  date?: string;
  currency?: string;
  exchangeRate?: number;
}

export function useCreateContactExpense() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateContactExpenseInput) => {
      const splitAmounts = input.splits.map((s) => s.amount);
      const decimals = getCurrencyDecimals(input.currency ?? "USD");
      if (!validateSplitsTotal(input.amount, splitAmounts, decimals)) {
        throw new Error("Split amounts must add up to the expense total");
      }

      const rate = input.exchangeRate ?? 1;
      const { data: expense, error } = await supabase.rpc(
        "create_contact_expense_with_splits",
        {
          p_contact_user_id: input.contactUserId,
          p_paid_by: input.paidBy,
          p_amount: input.amount,
          p_description: input.description,
          p_category: input.category ?? null,
          p_split_type: input.splitType,
          p_splits: buildSplitsPayload(input.splits, input.amount, rate),
          p_date: input.date ?? null,
          p_currency: input.currency ?? "USD",
          p_exchange_rate: rate,
        }
      );

      if (error) throw error;
      return expense;
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

interface UpdateContactExpenseInput extends CreateContactExpenseInput {
  expenseId: string;
}

export function useUpdateContactExpense() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (input: UpdateContactExpenseInput) => {
      const splitAmounts = input.splits.map((s) => s.amount);
      const decimals = getCurrencyDecimals(input.currency ?? "USD");
      if (!validateSplitsTotal(input.amount, splitAmounts, decimals)) {
        throw new Error("Split amounts must add up to the expense total");
      }

      const rate = input.exchangeRate ?? 1;
      const { data: expense, error } = await supabase.rpc(
        "update_contact_expense_with_splits",
        {
          p_expense_id: input.expenseId,
          p_paid_by: input.paidBy,
          p_amount: input.amount,
          p_description: input.description,
          p_category: input.category ?? null,
          p_split_type: input.splitType,
          p_splits: buildSplitsPayload(input.splits, input.amount, rate),
          p_date: input.date ?? null,
          p_currency: input.currency ?? "USD",
          p_exchange_rate: rate,
        }
      );

      if (error) throw error;
      return expense;
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

export function useDeleteContactExpense() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      expenseId,
    }: {
      expenseId: string;
      contactUserId: string;
    }) => {
      const { error } = await supabase.rpc("delete_contact_expense", {
        p_expense_id: expenseId,
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
