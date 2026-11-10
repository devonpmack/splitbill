import { View, FlatList, RefreshControl } from "react-native";
import {
  useRecentActivity,
  useUpcomingActivity,
} from "@/lib/queries/useExpenses";
import {
  useRecentPayments,
  useUpcomingPayments,
} from "@/lib/queries/usePayments";
import {
  useRecentContactActivity,
  useUpcomingContactActivity,
} from "@/lib/queries/useContactExpenses";
import {
  useRecentContactPayments,
  useUpcomingContactPayments,
} from "@/lib/queries/useContactPayments";
import { useRecentGroupSettingChanges } from "@/lib/queries/useGroups";
import { useAuth } from "@/lib/auth";
import { useAppTheme } from "@/lib/theme";
import {
  ActivityFeedItemCard,
  isInvolvedInExpense,
} from "@/components/activity/ActivityFeedItem";
import { buildActivityFeed } from "@/lib/utils";
import { Text } from "react-native-paper";
import { useNow } from "@/lib/useNow";
import type { ActivityContactExpense, ActivityFeedItem } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
import { LoadingScreen } from "@/components/LoadingScreen";
import { useState, useCallback } from "react";

type FeedRow =
  | { rowType: "heading"; id: string; title: string }
  | { rowType: "item"; item: ActivityFeedItem; upcoming: boolean };

export default function Activity() {
  const theme = useAppTheme();
  const { user } = useAuth();
  const {
    data: expenses,
    refetch: refetchExpenses,
    isLoading: expensesLoading,
  } = useRecentActivity();
  const {
    data: upcomingExpenses,
    refetch: refetchUpcoming,
    isLoading: upcomingLoading,
  } = useUpcomingActivity();
  const {
    data: payments,
    refetch: refetchPayments,
    isLoading: paymentsLoading,
  } = useRecentPayments();
  const {
    data: upcomingPayments,
    refetch: refetchUpcomingPayments,
    isLoading: upcomingPaymentsLoading,
  } = useUpcomingPayments();
  const {
    data: contactExpenses,
    refetch: refetchContactExpenses,
    isLoading: contactExpensesLoading,
  } = useRecentContactActivity();
  const {
    data: upcomingContactExpenses,
    refetch: refetchUpcomingContactExpenses,
    isLoading: upcomingContactExpensesLoading,
  } = useUpcomingContactActivity();
  const {
    data: contactPayments,
    refetch: refetchContactPayments,
    isLoading: contactPaymentsLoading,
  } = useRecentContactPayments();
  const {
    data: upcomingContactPayments,
    refetch: refetchUpcomingContactPayments,
    isLoading: upcomingContactPaymentsLoading,
  } = useUpcomingContactPayments();
  const {
    data: simplifyEvents,
    refetch: refetchSimplifyEvents,
    isLoading: simplifyEventsLoading,
  } = useRecentGroupSettingChanges();
  const [refreshing, setRefreshing] = useState(false);

  const isLoading =
    expensesLoading ||
    upcomingLoading ||
    paymentsLoading ||
    upcomingPaymentsLoading ||
    contactExpensesLoading ||
    upcomingContactExpensesLoading ||
    contactPaymentsLoading ||
    upcomingContactPaymentsLoading ||
    simplifyEventsLoading;

  const refetchAll = useCallback(
    () =>
      Promise.all([
        refetchExpenses(),
        refetchUpcoming(),
        refetchPayments(),
        refetchUpcomingPayments(),
        refetchContactExpenses(),
        refetchUpcomingContactExpenses(),
        refetchContactPayments(),
        refetchUpcomingContactPayments(),
        refetchSimplifyEvents(),
      ]),
    [
      refetchExpenses,
      refetchUpcoming,
      refetchPayments,
      refetchUpcomingPayments,
      refetchContactExpenses,
      refetchUpcomingContactExpenses,
      refetchContactPayments,
      refetchUpcomingContactPayments,
      refetchSimplifyEvents,
    ]
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetchAll();
    setRefreshing(false);
  }, [refetchAll]);

  // Contact expenses are still filtered here: RLS scopes them to the two
  // participants, but a zero-share expense is not the caller's activity.
  const involved = (rows: ActivityContactExpense[] | undefined) =>
    (rows ?? []).filter((row) => isInvolvedInExpense(row, user?.id));
  const sources = {
    expenses,
    upcomingExpenses,
    payments,
    upcomingPayments,
    contactExpenses: involved(contactExpenses),
    upcomingContactExpenses: involved(upcomingContactExpenses),
    contactPayments,
    upcomingContactPayments,
    simplifyEvents,
  };

  // Balances change when a row's date arrives, so the timer also refetches the
  // feed; the rows themselves move between the groups as `now` advances. Every
  // dated source feeds the timer. Simplify events are left out: they are never
  // upcoming.
  const now = useNow(
    [
      ...(expenses ?? []),
      ...(upcomingExpenses ?? []),
      ...(payments ?? []),
      ...(upcomingPayments ?? []),
      ...sources.contactExpenses,
      ...sources.upcomingContactExpenses,
      ...(contactPayments ?? []),
      ...(upcomingContactPayments ?? []),
    ].map((row) => row.date),
    () => {
      refetchAll();
    }
  );
  const { upcoming, past } = buildActivityFeed(sources, now);
  const rows: FeedRow[] = [
    ...(upcoming.length > 0
      ? [
          { rowType: "heading" as const, id: "upcoming", title: "Upcoming" },
          ...upcoming.map((item) => ({
            rowType: "item" as const,
            item,
            upcoming: true,
          })),
          ...(past.length > 0
            ? [{ rowType: "heading" as const, id: "history", title: "History" }]
            : []),
        ]
      : []),
    ...past.map((item) => ({ rowType: "item" as const, item, upcoming: false })),
  ];

  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <FlatList
        testID="activity-feed"
        data={rows}
        keyExtractor={(row) =>
          row.rowType === "heading"
            ? `heading-${row.id}`
            : `${row.item.kind}-${row.item.id}`
        }
        contentContainerStyle={{ padding: 16, flexGrow: 1 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <EmptyState
            icon="history"
            title="No recent activity"
            subtitle="Add expenses or settle up to see activity here"
          />
        }
        renderItem={({ item: row }) =>
          row.rowType === "heading" ? (
            <Text
              variant="titleMedium"
              style={{ fontWeight: "bold", marginBottom: 12 }}
            >
              {row.title}
            </Text>
          ) : (
            <ActivityFeedItemCard
              item={row.item}
              currentUserId={user?.id}
              upcoming={row.upcoming}
            />
          )
        }
      />
    </View>
  );
}
