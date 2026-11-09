import { View } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { Card, IconButton, Text } from "react-native-paper";
import { formatCurrency } from "@/lib/utils";
import { useAppTheme } from "@/lib/theme";
import type { ContactPaymentWithProfiles, PaymentWithProfiles } from "@/lib/types";

type PaymentCardProps = {
  payment: PaymentWithProfiles | ContactPaymentWithProfiles;
  currentUserId?: string;
  onDelete?: (paymentId: string) => void;
  onEdit?: (paymentId: string) => void;
};

export function PaymentCard({
  payment,
  currentUserId,
  onDelete,
  onEdit,
}: PaymentCardProps) {
  const theme = useAppTheme();
  const isPayer = payment.paid_by === currentUserId;
  const canDelete = !!onDelete;

  const payerName = isPayer ? "You" : (payment.payer?.full_name ?? "Someone");
  const payeeName =
    payment.paid_to === currentUserId
      ? "you"
      : (payment.payee?.full_name ?? "someone");

  const date = new Date(payment.date);
  const monthDay = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const year = date.getFullYear();

  return (
    <Card
      mode="contained"
      style={{ backgroundColor: theme.colors.secondaryContainer }}
      onPress={onEdit ? () => onEdit(payment.id) : undefined}
      onLongPress={canDelete ? () => onDelete!(payment.id) : undefined}
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
                style={{ color: theme.colors.onSecondaryContainer }}
              >
                {monthDay}
              </Text>
              <Text
                variant="labelSmall"
                style={{ color: theme.colors.onSecondaryContainer }}
              >
                {year}
              </Text>
            </View>
            <MaterialCommunityIcons
              name="cash-fast"
              size={22}
              color={theme.colors.onSecondaryContainer}
              style={{ marginRight: 10 }}
            />
            <View style={{ flex: 1 }}>
              <Text
                variant="titleMedium"
                style={{
                  fontWeight: "600",
                  color: theme.colors.onSecondaryContainer,
                }}
              >
                {payerName} paid {payeeName}{" "}
                {formatCurrency(payment.amount, payment.currency)}
              </Text>
            </View>
          </View>
          {onEdit && (
            <IconButton
              icon="pencil-outline"
              size={18}
              iconColor={theme.colors.onSecondaryContainer}
              onPress={() => onEdit(payment.id)}
              style={{ margin: 0, marginLeft: 4 }}
            />
          )}
          {canDelete && (
            <IconButton
              icon="trash-can-outline"
              size={18}
              iconColor={theme.colors.onSecondaryContainer}
              onPress={() => onDelete!(payment.id)}
              style={{ margin: 0, marginLeft: 4 }}
            />
          )}
        </View>
        {payment.note ? (
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSecondaryContainer, marginTop: 8 }}
          >
            {payment.note}
          </Text>
        ) : null}
      </Card.Content>
    </Card>
  );
}
