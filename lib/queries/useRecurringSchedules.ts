import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "../supabase";
import type {
  RecurringFrequency,
  RecurringSchedule,
  RecurringStopReason,
  SplitType,
} from "../types";
import type { ScheduleSummary } from "../recurrence";
import { useAuth } from "../auth";
import { getCurrencyDecimals } from "../currency";
import { validateSplitsTotal } from "../utils";
import {
  invalidateContactPairQueries,
  invalidateGroupQueries,
} from "./invalidate";
import { sortPair } from "./contact-pair";

// What a schedule belongs to: a group, or the one-on-one pair with a contact.
export type ScheduleScope =
  | { kind: "group"; groupId: string }
  | { kind: "contact"; contactUserId: string };

const SCHEDULES_KEY = "recurring-schedules";

export function useRecurringSchedules(scope: ScheduleScope) {
  const { user } = useAuth();

  return useQuery({
    queryKey:
      scope.kind === "group"
        ? [SCHEDULES_KEY, "group", scope.groupId]
        : [SCHEDULES_KEY, "contact", user?.id, scope.contactUserId],
    queryFn: async () => {
      const query = supabase.from("recurring_schedules").select("*");
      const scoped =
        scope.kind === "group"
          ? query.eq("group_id", scope.groupId)
          : (() => {
              const [lo, hi] = sortPair(user!.id, scope.contactUserId);
              return query.eq("user_lo", lo).eq("user_hi", hi);
            })();
      const { data, error } = await scoped.order("created_at", {
        ascending: false,
      });

      if (error) throw error;
      return data as unknown as RecurringSchedule[];
    },
    enabled:
      scope.kind === "group" ? !!scope.groupId : !!user && !!scope.contactUserId,
  });
}

// Every schedule the caller can see, by id: what a row needs to show its
// "Repeats monthly" chip, its date and its delete note, whichever list it is in.
export function useScheduleFrequencies() {
  const { user } = useAuth();

  return useQuery({
    queryKey: [SCHEDULES_KEY, "frequencies", user?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("recurring_schedules")
        .select("id, frequency, tz, stopped_at, stop_reason");

      if (error) throw error;
      const rows = data as unknown as {
        id: string;
        frequency: RecurringFrequency;
        tz: string;
        stopped_at: string | null;
        stop_reason: RecurringStopReason | null;
      }[];
      return Object.fromEntries(
        rows.map((row): [string, ScheduleSummary] => [
          row.id,
          {
            frequency: row.frequency,
            tz: row.tz,
            stopped: row.stopped_at !== null,
            stopReason: row.stop_reason,
          },
        ])
      );
    },
    enabled: !!user,
  });
}

function invalidateScope(
  queryClient: QueryClient,
  userId: string | undefined,
  scope: ScheduleScope
) {
  if (scope.kind === "group") {
    invalidateGroupQueries(queryClient, scope.groupId);
  } else {
    invalidateContactPairQueries(queryClient, userId, scope.contactUserId);
  }
  queryClient.invalidateQueries({ queryKey: [SCHEDULES_KEY] });
}

interface CreateRecurringScheduleInput {
  scope: ScheduleScope;
  paidBy: string;
  amount: number;
  description: string;
  category?: string;
  splitType: SplitType;
  // In the expense's own currency; the server converts each occurrence.
  splits: { userId: string; amount: number }[];
  currency: string;
  exchangeRate: number;
  // The first occurrence's local calendar day, "YYYY-MM-DD".
  startDate: string;
  timeZone: string;
  frequency: RecurringFrequency;
  endDate?: string;
  maxCount?: number;
}

export function useCreateRecurringSchedule() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (input: CreateRecurringScheduleInput) => {
      const splitAmounts = input.splits.map((s) => s.amount);
      const decimals = getCurrencyDecimals(input.currency);
      if (!validateSplitsTotal(input.amount, splitAmounts, decimals)) {
        throw new Error("Split amounts must add up to the expense total");
      }

      const { data: schedule, error } = await supabase.rpc(
        "create_recurring_schedule",
        {
          p_group_id: input.scope.kind === "group" ? input.scope.groupId : null,
          p_contact_id:
            input.scope.kind === "contact" ? input.scope.contactUserId : null,
          p_paid_by: input.paidBy,
          p_amount: input.amount,
          p_description: input.description,
          p_category: input.category ?? null,
          p_split_type: input.splitType,
          p_splits: input.splits.map(({ userId, amount }) => ({
            userId,
            amount,
          })),
          p_currency: input.currency,
          p_exchange_rate: input.exchangeRate,
          p_start_date: input.startDate,
          p_tz: input.timeZone,
          p_frequency: input.frequency,
          p_end_date: input.endDate ?? null,
          p_max_count: input.maxCount ?? null,
        }
      );

      if (error) throw error;
      return schedule;
    },
    onSuccess: (_, variables) => {
      invalidateScope(queryClient, user?.id, variables.scope);
    },
  });
}

export function useStopRecurringSchedule() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      scheduleId,
    }: {
      scheduleId: string;
      scope: ScheduleScope;
    }) => {
      const { error } = await supabase.rpc("stop_recurring_schedule", {
        p_schedule_id: scheduleId,
      });
      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      invalidateScope(queryClient, user?.id, variables.scope);
    },
  });
}
