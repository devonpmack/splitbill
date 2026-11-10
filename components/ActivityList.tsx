import { View } from "react-native";
import { Text } from "react-native-paper";
import { EmptyState } from "@/components/EmptyState";
import { ExpenseCard } from "@/components/groups/ExpenseCard";
import { PaymentCard } from "@/components/groups/PaymentCard";
import { partitionUpcoming } from "@/lib/upcoming";
import type {
  ContactExpenseWithSplits,
  ContactPaymentWithProfiles,
  ExpenseWithSplits,
  PaymentWithProfiles,
} from "@/lib/types";

// Mirrors ActivityFeedItem's shape: uniform kind/ts/payload so the list needs
// one branch for rendering and none for keying or sorting.
export type ActivityListItem =
  | {
      kind: "expense";
      ts: string;
      payload: ExpenseWithSplits | ContactExpenseWithSplits;
    }
  | {
      kind: "payment";
      ts: string;
      payload: PaymentWithProfiles | ContactPaymentWithProfiles;
    };

// Expenses and payments merged into list items, split into what is dated after
// `now` (soonest first) and the rest (newest first).
export function splitActivityListItems(
  expenses: (ExpenseWithSplits | ContactExpenseWithSplits)[],
  payments: (PaymentWithProfiles | ContactPaymentWithProfiles)[],
  now: Date
): { upcoming: ActivityListItem[]; past: ActivityListItem[] } {
  const items: ActivityListItem[] = [
    ...expenses.map(
      (payload): ActivityListItem => ({
        kind: "expense",
        ts: payload.date,
        payload,
      })
    ),
    ...payments.map(
      (payload): ActivityListItem => ({
        kind: "payment",
        ts: payload.date,
        payload,
      })
    ),
  ];
  return partitionUpcoming(items, (item) => item.ts, now);
}

type EmptyStateConfig = {
  icon?: React.ComponentProps<typeof EmptyState>["icon"];
  title: string;
  subtitle?: string;
};

type ActivityListProps = {
  items: ActivityListItem[];
  // Future-dated rows, shown first under an "Upcoming" heading.
  upcomingItems?: ActivityListItem[];
  title?: string;
  emptyState?: EmptyStateConfig;
  currentUserId?: string;
  onDeleteExpense: (expenseId: string) => void;
  onEditExpense: (expenseId: string) => void;
  onDeletePayment: (paymentId: string) => void;
  onEditPayment: (paymentId: string) => void;
};

export function ActivityList({
  items,
  upcomingItems = [],
  title,
  emptyState,
  currentUserId,
  onDeleteExpense,
  onEditExpense,
  onDeletePayment,
  onEditPayment,
}: ActivityListProps) {
  if (items.length === 0 && upcomingItems.length === 0) {
    return emptyState ? <EmptyState {...emptyState} /> : null;
  }

  const pastTitle = title ?? (upcomingItems.length > 0 ? "History" : undefined);

  const renderItems = (list: ActivityListItem[], upcoming: boolean) => (
    <View style={{ gap: 12 }}>
      {list.map((item) =>
        item.kind === "expense" ? (
          <ExpenseCard
            key={`expense-${item.payload.id}`}
            expense={item.payload}
            currentUserId={currentUserId}
            upcoming={upcoming}
            onDelete={onDeleteExpense}
            onEdit={onEditExpense}
          />
        ) : (
          <PaymentCard
            key={`payment-${item.payload.id}`}
            payment={item.payload}
            currentUserId={currentUserId}
            upcoming={upcoming}
            onDelete={onDeletePayment}
            onEdit={onEditPayment}
          />
        )
      )}
    </View>
  );

  return (
    <View style={{ gap: 16 }}>
      {upcomingItems.length > 0 ? (
        <View>
          <Text variant="titleMedium" style={{ fontWeight: "bold", marginBottom: 12 }}>
            Upcoming
          </Text>
          {renderItems(upcomingItems, true)}
        </View>
      ) : null}
      {items.length > 0 ? (
        <View>
          {pastTitle ? (
            <Text variant="titleMedium" style={{ fontWeight: "bold", marginBottom: 12 }}>
              {pastTitle}
            </Text>
          ) : null}
          {renderItems(items, false)}
        </View>
      ) : null}
    </View>
  );
}
