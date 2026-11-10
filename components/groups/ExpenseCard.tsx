import { View } from "react-native";
import { Card, IconButton, Text } from "react-native-paper";
import { formatCurrency } from "@/lib/utils";
import { useAppTheme } from "@/lib/theme";
import { UpcomingTag } from "@/components/UpcomingTag";
import { RepeatsTag } from "@/components/RepeatsTag";
import { useScheduleFrequencies } from "@/lib/queries/useRecurringSchedules";
import { rowDay } from "@/lib/dates";
import type { ContactExpenseWithSplits, ExpenseWithSplits } from "@/lib/types";
import { MaterialCommunityIcons } from "@expo/vector-icons";

type ExpenseCardProps = {
  expense: ExpenseWithSplits | ContactExpenseWithSplits;
  currentUserId?: string;
  onDelete: (expenseId: string) => void;
  onEdit?: (expenseId: string) => void;
  upcoming?: boolean;
};

export function ExpenseCard({
  expense,
  currentUserId,
  onDelete,
  onEdit,
  upcoming,
}: ExpenseCardProps) {
  const theme = useAppTheme();
  const isPayer = expense.paid_by === currentUserId;

  const userShare =
    expense.expense_splits?.find((split) => split.user_id === currentUserId)
      ?.amount ?? 0;
  const lentAmount = expense.amount - userShare;
  const isInvolved = isPayer || userShare > 0;
  const summaryAmount = isPayer ? lentAmount : userShare;
  const summaryColor =
    !isInvolved || summaryAmount <= 0
      ? theme.colors.onSurfaceVariant
      : isPayer
        ? theme.colors.success
        : theme.colors.error;

  const payerName = isPayer ? "You" : (expense.payer?.full_name ?? "Someone");
  const summaryLabel = isPayer ? "You lent" : "You borrowed";

  const { data: schedules } = useScheduleFrequencies();
  const date = rowDay(
    expense.date,
    expense.occurrence_date,
    expense.hand_edited,
    expense.schedule_id ? schedules?.[expense.schedule_id]?.tz : undefined
  );
  const monthDay = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const year = date.getFullYear();

  return (
    <Card
      mode="elevated"
      onPress={onEdit ? () => onEdit(expense.id) : undefined}
      onLongPress={() => onDelete(expense.id)}
    >
      <Card.Content>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <View
            style={{ flexDirection: "row", alignItems: "center", flex: 1 }}
          >
            <View style={{ alignItems: "center", marginRight: 10 }}>
              <Text
                variant="labelMedium"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                {monthDay}
              </Text>
              <Text
                variant="labelSmall"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                {year}
              </Text>
            </View>
            <MaterialCommunityIcons
              name="receipt"
              size={22}
              color={theme.colors.onSecondaryContainer}
              style={{ marginRight: 10 }}
            />
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium" style={{ fontWeight: "600" }}>
                {expense.description}
              </Text>
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                {payerName} paid {formatCurrency(expense.amount, expense.currency)}
              </Text>
              {upcoming || expense.schedule_id ? (
                <View
                  style={{
                    flexDirection: "row",
                    flexWrap: "wrap",
                    gap: 6,
                    marginTop: 4,
                  }}
                >
                  {upcoming ? <UpcomingTag /> : null}
                  {expense.schedule_id ? (
                    <RepeatsTag
                      scheduleId={expense.schedule_id}
                      upcoming={!!upcoming}
                    />
                  ) : null}
                </View>
              ) : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            {isInvolved ? (
              <View style={{ alignItems: "flex-end" }}>
                <Text variant="labelSmall" style={{ color: summaryColor }}>
                  {summaryLabel}
                </Text>
                <Text
                  variant="titleMedium"
                  style={{ fontWeight: "600", color: summaryColor }}
                >
                  {formatCurrency(summaryAmount, expense.currency)}
                </Text>
              </View>
            ) : (
              <Text
                variant="bodySmall"
                style={{ color: theme.colors.onSurfaceVariant }}
              >
                Not involved
              </Text>
            )}
            {onEdit && (
              <IconButton
                icon="pencil-outline"
                size={18}
                iconColor={theme.colors.onSecondaryContainer}
                onPress={() => onEdit(expense.id)}
                style={{ margin: 0, marginLeft: 4 }}
              />
            )}
            <IconButton
              icon="trash-can-outline"
              size={18}
              iconColor={theme.colors.onSecondaryContainer}
              onPress={() => onDelete(expense.id)}
              style={{ margin: 0, marginLeft: 4 }}
            />
          </View>
        </View>
      </Card.Content>
    </Card>
  );
}
