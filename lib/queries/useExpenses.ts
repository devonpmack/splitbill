import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../supabase";
import type {
  ActivityExpense,
  ExpenseWithSplits,
  SplitType,
} from "../types";
import { useAuth } from "../auth";
import { getCurrencyDecimals } from "../currency";
import { invalidateGroupQueries } from "./invalidate";
import { buildSplitsPayload, validateSplitsTotal } from "../utils";

const ACTIVITY_LIMIT = 50;

export function useRecentActivity() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["activity", user?.id],
    queryFn: async () => {
      // The RPC applies the "caller is involved" predicate before the row cap.
      // Selecting the 50 most recent expenses and filtering on the client
      // pushed the caller's own items out of the feed in busy groups.
      const { data, error } = await supabase.rpc("get_recent_activity", {
        p_limit: ACTIVITY_LIMIT,
      });

      if (error) throw error;
      return (data ?? []) as unknown as ActivityExpense[];
    },
    enabled: !!user,
  });
}

// Future-dated expenses the caller is involved in, soonest first. The key sits
// under ["activity"], so every activity invalidation covers it too.
export function useUpcomingActivity() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["activity", user?.id, "upcoming"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_upcoming_expenses", {
        p_limit: ACTIVITY_LIMIT,
      });

      if (error) throw error;
      return (data ?? []) as unknown as ActivityExpense[];
    },
    enabled: !!user,
  });
}

export function useExpenses(groupId: string) {
  return useQuery({
    queryKey: ["expenses", groupId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("expenses")
        .select(
          `
          *,
          payer:profiles!expenses_paid_by_fkey (*),
          expense_splits (
            *,
            profiles (*)
          )
        `
        )
        .eq("group_id", groupId)
        .order("date", { ascending: false });

      if (error) throw error;
      return data as unknown as ExpenseWithSplits[];
    },
    enabled: !!groupId,
  });
}

interface CreateExpenseInput {
  groupId: string;
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

export function useCreateExpense() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateExpenseInput) => {
      const splitAmounts = input.splits.map((s) => s.amount);
      const decimals = getCurrencyDecimals(input.currency ?? "USD");
      if (!validateSplitsTotal(input.amount, splitAmounts, decimals)) {
        throw new Error("Split amounts must add up to the expense total");
      }

      const rate = input.exchangeRate ?? 1;
      const { data: expense, error: expenseError } = await supabase.rpc(
        "create_expense_with_splits",
        {
          p_group_id: input.groupId,
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

      if (expenseError) throw expenseError;
      return expense;
    },
    onSuccess: (_, variables) => {
      invalidateGroupQueries(queryClient, variables.groupId);
    },
  });
}

interface UpdateExpenseInput extends CreateExpenseInput {
  expenseId: string;
}

export function useUpdateExpense() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: UpdateExpenseInput) => {
      const splitAmounts = input.splits.map((s) => s.amount);
      const decimals = getCurrencyDecimals(input.currency ?? "USD");
      if (!validateSplitsTotal(input.amount, splitAmounts, decimals)) {
        throw new Error("Split amounts must add up to the expense total");
      }

      const rate = input.exchangeRate ?? 1;
      const { data: expense, error: expenseError } = await supabase.rpc(
        "update_expense_with_splits",
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

      if (expenseError) throw expenseError;
      return expense;
    },
    onSuccess: (_, variables) => {
      invalidateGroupQueries(queryClient, variables.groupId);
    },
  });
}

export function useDeleteExpense() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      expenseId,
    }: {
      expenseId: string;
      groupId: string;
    }) => {
      const { error } = await supabase.rpc("delete_expense", {
        p_expense_id: expenseId,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_, variables) => {
      invalidateGroupQueries(queryClient, variables.groupId);
    },
  });
}
