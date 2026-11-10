import { View, FlatList, RefreshControl } from "react-native";
import {
  useRecentActivity,
  useUpcomingActivity,
} from "@/lib/queries/useExpenses";
import { useRecentPayments } from "@/lib/queries/usePayments";
import {
  useRecentContactActivity,
} from "@/lib/queries/useContactExpenses";
import {
  useRecentContactPayments,
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
import type { ActivityFeedItem } from "@/lib/types";
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
    data: contactExpenses,
    refetch: refetchContactExpenses,
    isLoading: contactExpensesLoading,
  } = useRecentContactActivity();
  const {
    data: contactPayments,
    refetch: refetchContactPayments,
    isLoading: contactPaymentsLoading,
  } = useRecentContactPayments();
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
    contactExpensesLoading ||
    contactPaymentsLoading ||
    simplifyEventsLoading;

  const refetchAll = useCallback(
    () =>
      Promise.all([
        refetchExpenses(),
        refetchUpcoming(),
        refetchPayments(),
        refetchContactExpenses(),
        refetchContactPayments(),
        refetchSimplifyEvents(),
      ]),
    [
      refetchExpenses,
      refetchUpcoming,
      refetchPayments,
      refetchContactExpenses,
      refetchContactPayments,
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
  const sources = {
    expenses,
    upcomingExpenses,
    payments,
    contactExpenses: (contactExpenses ?? []).filter((contactExpense) =>
      isInvolvedInExpense(contactExpense, user?.id)
    ),
    contactPayments,
    simplifyEvents,
  };

  // Balances change when a row's date arrives, so the timer also refetches the
  // feed; the rows themselves move between the groups as `now` advances.
  const now = useNow(
    [
      ...(upcomingExpenses ?? []),
      ...(payments ?? []),
      ...(sources.contactExpenses ?? []),
      ...(contactPayments ?? []),
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
