import { useState, useCallback } from "react";
import { View, ScrollView, RefreshControl } from "react-native";
import { router, Stack } from "expo-router";
import {
  useContacts,
  useContactBalance,
  useContactCurrency,
  useContactGroupBreakdown,
  useSetContactCurrency,
} from "@/lib/queries/useContacts";
import {
  useContactExpenses,
  useDeleteContactExpense,
} from "@/lib/queries/useContactExpenses";
import {
  useContactPayments,
  useDeleteContactPayment,
} from "@/lib/queries/useContactPayments";
import { useAuth } from "@/lib/auth";
import {
  formatContactSummaryLabel,
  getBalanceColor,
  hasSignificantBalance,
} from "@/lib/balance-display";
import { getErrorMessage } from "@/lib/utils";
import { useDisplayCurrency } from "@/lib/display-currency";
import { useSnackbar } from "@/lib/snackbar";
import { useConfirm } from "@/lib/confirm";
import { useAppTheme } from "@/lib/theme";
import { withSkipNote } from "@/lib/recurrence";
import { useNow } from "@/lib/useNow";
import { ActivityList, splitActivityListItems } from "@/components/ActivityList";
import { DualActionBar } from "@/components/DualActionBar";
import { EmptyState } from "@/components/EmptyState";
import { ContactGroupBreakdownList } from "@/components/contacts/ContactGroupBreakdownList";
import { ContactSummaryCard } from "@/components/contacts/ContactSummaryCard";

export type ContactDetailScreenProps = {
  contactUserId: string;
  name?: string;
  // The tab stack hosting this screen. Navigation targets resolve against it so
  // back returns to the tab that opened the contact (mirrors GroupDetailScreen's
  // leaveFallbackRoute).
  routeBase?: "" | "/activity";
};

export function ContactDetailScreen({
  contactUserId,
  name,
  routeBase = "",
}: ContactDetailScreenProps) {
  const onOpenGroup = (groupId: string) =>
    router.push(`${routeBase}/group/${groupId}`);
  const onAddExpense = () =>
    router.push({
      pathname: `${routeBase}/contacts/add-expense`,
      params: { contactUserId },
    });
  const onEditExpense = (expenseId: string) =>
    router.push({
      pathname: `${routeBase}/contacts/add-expense`,
      params: { contactUserId, expenseId },
    });
  const onSettleUp = () =>
    router.push({
      pathname: `${routeBase}/contacts/settle-up`,
      params: { contactUserId },
    });
  const onEditPayment = (paymentId: string) =>
    router.push({
      pathname: `${routeBase}/contacts/settle-up`,
      params: { contactUserId, paymentId },
    });
  const theme = useAppTheme();
  const { user } = useAuth();
  const { currency: displayCurrency } = useDisplayCurrency();
  const { data: contacts } = useContacts();
  const { data: balance = 0, refetch: refetchBalance } = useContactBalance(contactUserId);
  const { data: expenses, refetch: refetchExpenses } = useContactExpenses(contactUserId);
  const { data: payments, refetch: refetchPayments } = useContactPayments(contactUserId);
  const { data: groupBreakdown, refetch: refetchGroupBreakdown } =
    useContactGroupBreakdown(contactUserId);
  const { data: pairCurrency = "USD" } = useContactCurrency(contactUserId);
  const setContactCurrency = useSetContactCurrency();
  const deleteContactExpense = useDeleteContactExpense();
  const deleteContactPayment = useDeleteContactPayment();
  const { showError } = useSnackbar();

  const hasOneOnOneActivity =
    (expenses?.length ?? 0) > 0 || (payments?.length ?? 0) > 0;
  const confirm = useConfirm();
  const [refreshing, setRefreshing] = useState(false);

  const contact = contacts?.find((c) => c.contact_user_id === contactUserId);
  const contactName = contact?.full_name ?? name ?? "Contact";
  // Group-mates surfaced only via a shared (possibly simplified) balance aren't
  // accepted contacts, so 1-on-1 actions and the pair-currency editor don't
  // apply to them.
  const isAccepted = contact?.is_accepted ?? true;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      refetchBalance(),
      refetchExpenses(),
      refetchPayments(),
      refetchGroupBreakdown(),
    ]);
    setRefreshing(false);
  }, [refetchBalance, refetchExpenses, refetchPayments, refetchGroupBreakdown]);

  const groups = groupBreakdown ?? [];
  const hasGroups = groups.length > 0;

  // A date arriving changes what the server counts, so the timer refetches the
  // balance too; the rows move out of Upcoming as `now` advances.
  const now = useNow(
    [...(expenses ?? []), ...(payments ?? [])].map((row) => row.date),
    () => {
      refetchBalance();
      refetchExpenses();
      refetchPayments();
      refetchGroupBreakdown();
    }
  );
  const { upcoming: upcomingItems, past: activityItems } =
    splitActivityListItems(expenses ?? [], payments ?? [], now);
  const hasActivity = activityItems.length > 0 || upcomingItems.length > 0;

  const handleDeleteExpense = (expenseId: string) => {
    const isOccurrence = !!expenses?.find((e) => e.id === expenseId)
      ?.schedule_id;
    confirm({
      title: "Delete Expense",
      message: withSkipNote(
        "Are you sure you want to delete this expense? This will remove it for both people involved.",
        isOccurrence
      ),
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        deleteContactExpense.mutate(
          { expenseId, contactUserId: contactUserId },
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
      message:
        "Are you sure you want to delete this payment? This will remove it for both people involved.",
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        deleteContactPayment.mutate(
          { paymentId, contactUserId: contactUserId },
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

  const showSummaryAmount = hasSignificantBalance(balance);
  const summaryColor = getBalanceColor(balance, theme.colors);
  const summaryLabel = formatContactSummaryLabel(balance, contactName);

  return (
    <>
      <Stack.Screen options={{ title: contactName }} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <ScrollView
          style={{ flex: 1 }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          contentContainerStyle={{ padding: 16 }}
        >
          <ContactSummaryCard
            summaryLabel={summaryLabel}
            showAmount={showSummaryAmount}
            balance={balance}
            displayCurrency={displayCurrency}
            summaryColor={summaryColor}
            pairCurrency={pairCurrency}
            hasOneOnOneActivity={hasOneOnOneActivity}
            currencyPending={setContactCurrency.isPending}
            canEditCurrency={isAccepted}
            onChangeCurrency={(currency, onError) =>
              setContactCurrency.mutate(
                { contactUserId: contactUserId, currency },
                { onError }
              )
            }
            onCurrencyError={showError}
          />

          <ContactGroupBreakdownList
            groups={groups}
            contactName={contactName}
            onOpenGroup={onOpenGroup}
          />

          <ActivityList
            items={activityItems}
            upcomingItems={upcomingItems}
            title={hasGroups ? "One-on-one" : undefined}
            currentUserId={user?.id}
            onDeleteExpense={handleDeleteExpense}
            onEditExpense={onEditExpense}
            onDeletePayment={handleDeletePayment}
            onEditPayment={onEditPayment}
          />

          {!hasGroups && !hasActivity && (
            <EmptyState
              icon="timeline-text-outline"
              title="No activity yet"
              subtitle="Add an expense to start tracking"
            />
          )}
        </ScrollView>

        {isAccepted && (
          <DualActionBar onPrimary={onAddExpense} onSecondary={onSettleUp} />
        )}
      </View>
    </>
  );
}
