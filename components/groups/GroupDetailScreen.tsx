import { useState, useCallback } from "react";
import { View, ScrollView, RefreshControl } from "react-native";
import { router, Stack } from "expo-router";
import { SegmentedButtons } from "react-native-paper";
import { useGroup, useLeaveGroup } from "@/lib/queries/useGroups";
import { useExpenses, useDeleteExpense } from "@/lib/queries/useExpenses";
import { useGroupPayments, useDeletePayment } from "@/lib/queries/usePayments";
import {
  useGroupBalances,
  useGroupPairwiseBalances,
  useGroupSimplifiedEdges,
} from "@/lib/queries/useBalances";
import { useAuth } from "@/lib/auth";
import { getBalanceColor } from "@/lib/balance-display";
import {
  getErrorMessage,
  memberDebtBreakdown,
  netDebtsByCounterparty,
  sortMembersSelfFirst,
} from "@/lib/utils";
import { useRealtimeSubscription } from "@/lib/realtime";
import { useSnackbar } from "@/lib/snackbar";
import { useConfirm } from "@/lib/confirm";
import { useAppTheme } from "@/lib/theme";
import { useNow } from "@/lib/useNow";
import { ActivityList, splitActivityListItems } from "@/components/ActivityList";
import { DualActionBar } from "@/components/DualActionBar";
import { GroupBalancesList } from "@/components/groups/GroupBalancesList";
import { GroupHeaderActions } from "@/components/groups/GroupHeaderActions";
import { GroupMembersCard } from "@/components/groups/GroupMembersCard";

type TabType = "activity" | "balances";

export function GroupDetailScreen({
  groupId,
  // Where to land after leaving the group when there's no back stack to pop.
  // Depends on which tab hosts this screen (Groups list vs. the Home tab).
  leaveFallbackRoute = "/(tabs)/groups",
}: {
  groupId: string;
  leaveFallbackRoute?: "/(tabs)/groups" | "/(tabs)/(home)" | "/(tabs)/activity";
}) {
  const theme = useAppTheme();
  const { user } = useAuth();
  const { data: group, refetch: refetchGroup } = useGroup(groupId);
  const { data: expenses, refetch: refetchExpenses } = useExpenses(groupId);
  const { data: payments, refetch: refetchPayments } = useGroupPayments(groupId);
  const { data: balances, refetch: refetchBalances } = useGroupBalances(groupId);
  const simplify = group?.simplify_debts ?? true;
  const { data: rawDebts, refetch: refetchRawDebts } =
    useGroupPairwiseBalances(groupId, !simplify);
  const { data: simplifiedDebts, refetch: refetchSimplifiedDebts } =
    useGroupSimplifiedEdges(groupId, simplify);
  const deleteExpense = useDeleteExpense();
  const deletePayment = useDeletePayment();
  const leaveGroup = useLeaveGroup();
  const { showError, showInfo } = useSnackbar();
  const confirm = useConfirm();
  const [activeTab, setActiveTab] = useState<TabType>("activity");
  const [refreshing, setRefreshing] = useState(false);

  useRealtimeSubscription(groupId);

  const handleLeaveGroup = () => {
    if (!balances) {
      showInfo("Still checking your balance. Try again in a moment.");
      return;
    }
    const myBalance =
      balances.find((b) => b.user_id === user?.id)?.balance ?? 0;
    if (Math.abs(myBalance) >= 0.01) {
      showInfo(
        "You have an outstanding balance in this group. Settle up before leaving."
      );
      return;
    }
    confirm({
      title: "Leave Group",
      message: `Are you sure you want to leave "${group?.name ?? "this group"}"?`,
      confirmText: "Leave",
      destructive: true,
      onConfirm: async () => {
        try {
          await leaveGroup.mutateAsync(groupId);
          if (router.canGoBack()) {
            router.back();
          } else {
            router.replace(leaveFallbackRoute);
          }
        } catch (error) {
          showError(
            getErrorMessage(error, "Couldn't leave the group. Please try again.")
          );
        }
      },
    });
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      refetchGroup(),
      refetchExpenses(),
      refetchPayments(),
      refetchBalances(),
      refetchRawDebts(),
      refetchSimplifiedDebts(),
    ]);
    setRefreshing(false);
  }, [
    refetchGroup,
    refetchExpenses,
    refetchPayments,
    refetchBalances,
    refetchRawDebts,
    refetchSimplifiedDebts,
  ]);

  const handleDeleteExpense = (expenseId: string) => {
    confirm({
      title: "Delete Expense",
      message: "Are you sure you want to delete this expense? This will remove it for ALL people involved.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        deleteExpense.mutate(
          { expenseId, groupId },
          {
            onError: (error) =>
              showError(
                getErrorMessage(
                  error,
                  "Couldn't delete the expense. Please try again."
                )
              ),
          }
        );
      },
    });
  };

  const handleDeletePayment = (paymentId: string) => {
    confirm({
      title: "Delete Payment",
      message: "Are you sure you want to delete this payment? This will remove it for ALL people involved.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        deletePayment.mutate(
          { paymentId, groupId },
          {
            onError: (error) =>
              showError(
                getErrorMessage(
                  error,
                  "Couldn't delete the payment. Please try again."
                )
              ),
          }
        );
      },
    });
  };

  // A date arriving changes what the server counts, so the timer refetches the
  // balances too; the rows move out of Upcoming as `now` advances.
  const now = useNow(
    [...(expenses ?? []), ...(payments ?? [])].map((row) => row.date),
    () => {
      refetchExpenses();
      refetchPayments();
      refetchBalances();
      refetchRawDebts();
      refetchSimplifiedDebts();
    }
  );
  const { upcoming: upcomingItems, past: activityItems } =
    splitActivityListItems(expenses ?? [], payments ?? [], now);

  const debts = simplify ? (simplifiedDebts ?? []) : (rawDebts ?? []);

  const balanceColor = (value: number) => getBalanceColor(value, theme.colors);
  const memberBreakdown = (userId: string) =>
    memberDebtBreakdown(debts, userId);

  const groupCurrency = group?.currency ?? "USD";
  // Derive the members-card balances from the same debt edges shown elsewhere so
  // the roster, the per-member breakdown, and the simplify toggle stay in sync.
  const pairwiseByUser = netDebtsByCounterparty(debts, user?.id);
  const members = sortMembersSelfFirst(group?.group_members ?? [], user?.id);

  return (
    <>
      <Stack.Screen
        options={{
          title: group?.name ?? "Group",
          headerRight: () => (
            <GroupHeaderActions
              onSettings={() =>
                router.push({
                  pathname: "/group-manage",
                  params: { groupId },
                })
              }
              onLeave={handleLeaveGroup}
            />
          ),
        }}
      />
      <View
        style={{ flex: 1, backgroundColor: theme.colors.background }}
      >
        <GroupMembersCard
          members={members}
          currentUserId={user?.id}
          pairwiseByUser={pairwiseByUser}
          currency={groupCurrency}
          onAddMembers={() =>
            router.push({
              pathname: "/group-add-members",
              params: { groupId },
            })
          }
        />

        <View style={{ paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4 }}>
          <SegmentedButtons
            value={activeTab}
            onValueChange={(v) => setActiveTab(v as TabType)}
            theme={{
              colors: {
                secondaryContainer: theme.colors.secondaryContainer,
                onSecondaryContainer: theme.colors.onSecondaryContainer,
              },
            }}
            buttons={[
              {
                value: "activity",
                label: "Activity",
                icon: "format-list-bulleted",
              },
              { value: "balances", label: "Balances", icon: "scale-balance" },
            ]}
          />
        </View>

        <ScrollView
          style={{ flex: 1 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          contentContainerStyle={{ padding: 16 }}
        >
          {activeTab === "activity" ? (
            <ActivityList
              items={activityItems}
              upcomingItems={upcomingItems}
              emptyState={{
                icon: "timeline-text-outline",
                title: "No activity yet",
              }}
              currentUserId={user?.id}
              onDeleteExpense={handleDeleteExpense}
              onEditExpense={(expenseId) =>
                router.push({
                  pathname: "/group-add-expense",
                  params: { groupId, expenseId },
                })
              }
              onDeletePayment={handleDeletePayment}
              onEditPayment={(paymentId) =>
                router.push({
                  pathname: "/group-edit-payment",
                  params: { groupId, paymentId },
                })
              }
            />
          ) : (
            <GroupBalancesList
              balances={balances}
              currency={groupCurrency}
              getBreakdown={memberBreakdown}
              getAccentColor={balanceColor}
            />
          )}
        </ScrollView>

        <DualActionBar
          onPrimary={() =>
            router.push({
              pathname: "/group-add-expense",
              params: { groupId },
            })
          }
          onSecondary={() =>
            router.push({
              pathname: "/group-settle-up",
              params: { groupId },
            })
          }
        />
      </View>
    </>
  );
}
