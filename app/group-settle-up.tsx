import { useState } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Text } from "react-native-paper";
import {
  useGroupPairwiseBalances,
  useGroupSimplifiedEdges,
} from "@/lib/queries/useBalances";
import { useGroup } from "@/lib/queries/useGroups";
import { useCreatePayment } from "@/lib/queries/usePayments";
import { useAuth } from "@/lib/auth";
import { useDayPick } from "@/lib/useDayPick";
import { getErrorMessage } from "@/lib/utils";
import { useSnackbar } from "@/lib/snackbar";
import { useAppTheme } from "@/lib/theme";
import { FormScreen } from "@/components/FormScreen";
import { PaymentAmountNoteFields } from "@/components/PaymentAmountNoteFields";
import { DebtCard } from "@/components/groups/DebtCard";
import { EmptyState } from "@/components/EmptyState";
import { LoadingScreen } from "@/components/LoadingScreen";
import type { DebtEdge } from "@/lib/types";

const debtKey = (debt: DebtEdge) => `${debt.from}:${debt.to}`;

export default function SettleUp() {
  const theme = useAppTheme();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { user } = useAuth();
  const { data: group } = useGroup(groupId!);
  const groupCurrency = group?.currency ?? "USD";
  const simplify = group?.simplify_debts ?? true;
  const rawDebtsQuery = useGroupPairwiseBalances(groupId!, !simplify);
  const simplifiedDebtsQuery = useGroupSimplifiedEdges(groupId!, simplify);
  const createPayment = useCreatePayment();
  const { showError, showSuccess } = useSnackbar();

  const [selectedDebtKey, setSelectedDebtKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const day = useDayPick();

  // Which query is active depends on the group's simplify_debts flag, so the
  // group itself must have loaded before an empty debt list means "settled".
  const activeDebts = simplify ? simplifiedDebtsQuery.data : rawDebtsQuery.data;
  const isLoadingDebts = !group || activeDebts === undefined;
  const debts = activeDebts ?? [];
  const userDebts = debts.filter(
    (d) => d.from === user?.id || d.to === user?.id
  );
  const selectedDebt = selectedDebtKey
    ? userDebts.find((debt) => debtKey(debt) === selectedDebtKey)
    : undefined;

  const handleSettle = async () => {
    if (!selectedDebt) {
      showError("Please select a payment to settle");
      return;
    }

    // Fall back to the full debt only when the field is empty/unparseable — an
    // explicit 0 should be rejected, not silently replaced with the debt total.
    const parsedAmount = parseFloat(amount);
    const settleAmount = Number.isNaN(parsedAmount)
      ? selectedDebt.amount
      : parsedAmount;

    if (settleAmount <= 0) {
      showError("Please enter a valid amount");
      return;
    }
    if (day.isInvalid) {
      showError("Please enter a valid date");
      return;
    }

    try {
      await createPayment.mutateAsync({
        groupId: groupId!,
        paidBy: selectedDebt.from,
        paidTo: selectedDebt.to,
        amount: settleAmount,
        note: note.trim() || undefined,
        currency: groupCurrency,
        date: day.dateParam,
      });
      showSuccess("Payment recorded!");
      router.back();
    } catch (error) {
      showError(
        getErrorMessage(error, "Couldn't record payment. Please try again.")
      );
    }
  };

  if (isLoadingDebts) {
    return <LoadingScreen />;
  }

  return (
    <FormScreen>
      {userDebts.length === 0 ? (
        <EmptyState title="You're all settled up in this group!" />
      ) : (
        <>
          <Text
            variant="labelLarge"
            style={{ color: theme.colors.onSurfaceVariant, marginBottom: 12 }}
          >
            Select a payment to settle
          </Text>
          <View style={{ gap: 8 }}>
            {userDebts.map((debt, idx) => (
              <DebtCard
                key={debtKey(debt)}
                debt={debt}
                index={idx}
                isFrom={debt.from === user?.id}
                selected={selectedDebtKey === debtKey(debt)}
                currency={groupCurrency}
                onSelect={() => {
                  setSelectedDebtKey(debtKey(debt));
                  setAmount(debt.amount.toFixed(2));
                }}
              />
            ))}
          </View>

          {selectedDebt && (
            <>
              <PaymentAmountNoteFields
                amount={amount}
                onAmountChange={setAmount}
                note={note}
                onNoteChange={setNote}
                date={day.value}
                onDateChange={day.onChange}
                currency={groupCurrency}
              />

              <Button
                mode="contained"
                buttonColor={theme.colors.secondary}
                textColor={theme.colors.onSecondary}
                onPress={handleSettle}
                loading={createPayment.isPending}
                disabled={createPayment.isPending}
                contentStyle={{ paddingVertical: 6 }}
                style={{ marginTop: 32 }}
              >
                Record Payment
              </Button>
            </>
          )}
        </>
      )}
    </FormScreen>
  );
}
