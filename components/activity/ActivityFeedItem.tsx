import { router } from "expo-router";
import {
  ActivityRow,
  type ActivityRowTrailing,
} from "@/components/activity/ActivityRow";
import type {
  ActivityContactExpense,
  ActivityContactPayment,
  ActivityExpense,
  ActivityFeedItem,
  ActivityPayment,
  ActivitySimplifyDebtsEvent,
  Profile,
} from "@/lib/types";
import { formatCurrency } from "@/lib/utils";
import { useAppTheme } from "@/lib/theme";

type ActivityFeedItemCardProps = {
  item: ActivityFeedItem;
  currentUserId?: string;
  upcoming?: boolean;
};

export function ActivityFeedItemCard({
  item,
  currentUserId,
  upcoming,
}: ActivityFeedItemCardProps) {
  switch (item.kind) {
    case "expense":
      return (
        <ExpenseRow
          item={item.payload}
          currentUserId={currentUserId}
          upcoming={upcoming}
        />
      );
    case "payment":
      return (
        <PaymentRow
          item={item.payload}
          currentUserId={currentUserId}
          upcoming={upcoming}
        />
      );
    case "contact-expense":
      return (
        <ContactExpenseRow
          item={item.payload}
          currentUserId={currentUserId}
          upcoming={upcoming}
        />
      );
    case "contact-payment":
      return (
        <ContactPaymentRow
          item={item.payload}
          currentUserId={currentUserId}
          upcoming={upcoming}
        />
      );
    case "simplify-debts":
      return (
        <SimplifyDebtsRow item={item.payload} currentUserId={currentUserId} />
      );
  }
}

// True when the current user paid for or has a split in the expense.
export function isInvolvedInExpense(
  expense: {
    paid_by: string;
    expense_splits: { user_id: string; amount: number }[];
  },
  currentUserId: string | undefined
): boolean {
  if (expense.paid_by === currentUserId) return true;
  const userShare =
    expense.expense_splits?.find((split) => split.user_id === currentUserId)
      ?.amount ?? 0;
  return userShare > 0;
}

// Net summary for the current user on an expense: positive means they lent
// (get back, shown green), negative means they borrowed (owe, shown red).
function getExpenseSummary(
  expense: {
    amount: number;
    paid_by: string;
    expense_splits: { user_id: string; amount: number }[];
  },
  currentUserId: string | undefined,
  theme: ReturnType<typeof useAppTheme>
) {
  const isPayer = expense.paid_by === currentUserId;
  const userShare =
    expense.expense_splits?.find((split) => split.user_id === currentUserId)
      ?.amount ?? 0;
  const lentAmount = expense.amount - userShare;
  const isInvolved = isPayer || userShare > 0;
  const amount = isPayer ? lentAmount : userShare;
  const color =
    !isInvolved || amount <= 0
      ? theme.colors.onSurfaceVariant
      : isPayer
        ? theme.colors.success
        : theme.colors.error;
  return {
    isInvolved,
    amount,
    color,
    label: isPayer ? "You lent" : "You borrowed",
  };
}

function expenseTrailing(
  summary: ReturnType<typeof getExpenseSummary>,
  currency: string
): ActivityRowTrailing {
  return summary.isInvolved
    ? {
        kind: "summary",
        label: summary.label,
        text: formatCurrency(summary.amount, currency),
        color: summary.color,
      }
    : { kind: "muted", text: "Not involved" };
}

function payerLabel(
  paidBy: string,
  currentUserId: string | undefined,
  payer: Profile | null
): string {
  return paidBy === currentUserId ? "You" : (payer?.full_name ?? "Someone");
}

function ExpenseRow({
  item,
  currentUserId,
  upcoming,
}: {
  item: ActivityExpense;
  currentUserId?: string;
  upcoming?: boolean;
}) {
  const theme = useAppTheme();
  const summary = getExpenseSummary(item, currentUserId, theme);

  return (
    <ActivityRow
      icon="receipt"
      title={item.description}
      subtitle={`${payerLabel(item.paid_by, currentUserId, item.payer)} paid ${formatCurrency(item.amount, item.currency)} in ${item.groups?.name ?? "a group"}`}
      date={item.date}
      upcoming={upcoming}
      scheduleId={item.schedule_id}
      occurrenceDate={item.occurrence_date}
      handEdited={item.hand_edited}
      onPress={() => router.push(`/activity/group/${item.group_id}`)}
      trailing={expenseTrailing(summary, item.currency)}
      edit={{
        label: "Edit expense",
        onPress: () =>
          router.push({
            pathname: "/group-add-expense",
            params: { groupId: item.group_id, expenseId: item.id },
          }),
      }}
    />
  );
}

function ContactExpenseRow({
  item,
  currentUserId,
  upcoming,
}: {
  item: ActivityContactExpense;
  currentUserId?: string;
  upcoming?: boolean;
}) {
  const theme = useAppTheme();
  const summary = getExpenseSummary(item, currentUserId, theme);
  const otherProfile =
    item.paid_by === item.user_lo ? item.user_hi_profile : item.user_lo_profile;
  const otherName =
    otherProfile?.id === currentUserId
      ? "you"
      : (otherProfile?.full_name ?? "someone");
  const contactUserId =
    item.user_lo === currentUserId ? item.user_hi : item.user_lo;
  const contactProfile =
    item.user_lo === currentUserId
      ? item.user_hi_profile
      : item.user_lo_profile;

  return (
    <ActivityRow
      icon="account-cash"
      title={item.description}
      subtitle={`${payerLabel(item.paid_by, currentUserId, item.payer)} paid ${formatCurrency(item.amount, item.currency)} \u00b7 with ${otherName}`}
      date={item.date}
      upcoming={upcoming}
      scheduleId={item.schedule_id}
      occurrenceDate={item.occurrence_date}
      handEdited={item.hand_edited}
      onPress={() =>
        router.push({
          pathname: "/activity/contacts/[id]",
          params: { id: contactUserId, name: contactProfile?.full_name ?? "" },
        })
      }
      trailing={expenseTrailing(summary, item.currency)}
      edit={{
        label: "Edit expense",
        onPress: () =>
          router.push({
            pathname: "/activity/contacts/add-expense",
            params: { contactUserId, expenseId: item.id },
          }),
      }}
    />
  );
}

function PaymentRow({
  item,
  currentUserId,
  upcoming,
}: {
  item: ActivityPayment;
  currentUserId?: string;
  upcoming?: boolean;
}) {
  const payeeName =
    item.paid_to === currentUserId
      ? "you"
      : (item.payee?.full_name ?? "someone");

  return (
    <ActivityRow
      tone="secondary"
      icon="cash-fast"
      title={`${payerLabel(item.paid_by, currentUserId, item.payer)} paid ${payeeName}`}
      subtitle={`in ${item.groups?.name ?? "a group"}`}
      note={item.note}
      date={item.date}
      upcoming={upcoming}
      onPress={() => router.push(`/activity/group/${item.group_id}`)}
      trailing={{
        kind: "amount",
        text: formatCurrency(item.amount, item.currency),
      }}
      edit={{
        label: "Edit payment",
        onPress: () =>
          router.push({
            pathname: "/group-edit-payment",
            params: { groupId: item.group_id, paymentId: item.id },
          }),
      }}
    />
  );
}

function ContactPaymentRow({
  item,
  currentUserId,
  upcoming,
}: {
  item: ActivityContactPayment;
  currentUserId?: string;
  upcoming?: boolean;
}) {
  const payeeName =
    item.paid_to === currentUserId
      ? "you"
      : (item.payee?.full_name ?? "someone");
  const isPayer = item.paid_by === currentUserId;
  const contactUserId = isPayer ? item.paid_to : item.paid_by;
  const contactProfile = isPayer ? item.payee : item.payer;

  return (
    <ActivityRow
      tone="secondary"
      icon="cash-fast"
      title={`${payerLabel(item.paid_by, currentUserId, item.payer)} paid ${payeeName}`}
      note={item.note}
      date={item.date}
      upcoming={upcoming}
      onPress={() =>
        router.push({
          pathname: "/activity/contacts/[id]",
          params: { id: contactUserId, name: contactProfile?.full_name ?? "" },
        })
      }
      trailing={{
        kind: "amount",
        text: formatCurrency(item.amount, item.currency),
      }}
      edit={{
        label: "Edit payment",
        onPress: () =>
          router.push({
            pathname: "/activity/contacts/settle-up",
            params: { contactUserId, paymentId: item.id },
          }),
      }}
    />
  );
}

function SimplifyDebtsRow({
  item,
  currentUserId,
}: {
  item: ActivitySimplifyDebtsEvent;
  currentUserId?: string;
}) {
  const actorName =
    item.actor_id === currentUserId
      ? "You"
      : (item.actor?.full_name ?? "Someone");

  return (
    <ActivityRow
      icon="call-split"
      title={`${actorName} ${item.enabled ? "turned on" : "turned off"} simplify debts`}
      subtitle={`in ${item.groups?.name ?? "a group"}`}
      date={item.created_at}
      onPress={() => router.push(`/activity/group/${item.group_id}`)}
    />
  );
}
