import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "react-native-paper";
import { useGroup } from "@/lib/queries/useGroups";
import { useGroupPayments, useUpdatePayment } from "@/lib/queries/usePayments";
import { useAuth } from "@/lib/auth";
import { useDayPick } from "@/lib/useDayPick";
import { useHydrateOnce } from "@/lib/useHydrateOnce";
import { getErrorMessage } from "@/lib/utils";
import { useSnackbar } from "@/lib/snackbar";
import { useAppTheme } from "@/lib/theme";
import type { MemberWithProfile } from "@/lib/types";
import { FormScreen } from "@/components/FormScreen";
import { PaymentAmountNoteFields } from "@/components/PaymentAmountNoteFields";
import { PaidByPicker } from "@/components/groups/PaidByPicker";

export default function EditPayment() {
  const theme = useAppTheme();
  const { groupId, paymentId } = useLocalSearchParams<{
    groupId: string;
    paymentId: string;
  }>();
  const { user } = useAuth();
  const { data: group } = useGroup(groupId!);
  const { data: payments } = useGroupPayments(groupId!);
  const updatePayment = useUpdatePayment();
  const { showError, showSuccess } = useSnackbar();

  const [paidBy, setPaidBy] = useState("");
  const [paidTo, setPaidTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const members = group?.group_members ?? [];
  const payment = payments?.find((p) => p.id === paymentId);
  const day = useDayPick(payment?.date);

  useHydrateOnce(!!payment, () => {
    if (!payment) return;
    setPaidBy(payment.paid_by);
    setPaidTo(payment.paid_to);
    setAmount(payment.amount.toFixed(2));
    setNote(payment.note ?? "");
  });

  const memberName = (member: MemberWithProfile) =>
    member.profiles?.full_name ??
    (member.user_id === user?.id ? "You" : "Unknown");

  const handleSave = async () => {
    const totalAmount = parseFloat(amount) || 0;
    if (!paidBy || !paidTo) {
      showError("Please select who paid whom");
      return;
    }
    if (paidBy === paidTo) {
      showError("Payer and recipient must be different people");
      return;
    }
    if (totalAmount <= 0) {
      showError("Please enter a valid amount");
      return;
    }
    if (day.isInvalid) {
      showError("Please enter a valid date");
      return;
    }

    try {
      await updatePayment.mutateAsync({
        paymentId: paymentId!,
        groupId: groupId!,
        paidBy,
        paidTo,
        amount: totalAmount,
        note: note.trim() || undefined,
        date: day.dateParam,
      });
      showSuccess("Payment updated!");
      router.back();
    } catch (error) {
      showError(
        getErrorMessage(error, "Couldn't update payment. Please try again.")
      );
    }
  };

  return (
    <FormScreen>
      <PaidByPicker
        label="Paid by"
        members={members}
        paidBy={paidBy}
        onSelect={setPaidBy}
        getMemberName={memberName}
      />

      <PaidByPicker
        label="Paid to"
        members={members}
        paidBy={paidTo}
        onSelect={setPaidTo}
        getMemberName={memberName}
      />

      <PaymentAmountNoteFields
        amount={amount}
        onAmountChange={setAmount}
        note={note}
        onNoteChange={setNote}
        date={day.value}
        onDateChange={day.onChange}
        amountSectionLabel="Amount"
      />

      <Button
        mode="contained"
        buttonColor={theme.colors.secondary}
        textColor={theme.colors.onSecondary}
        onPress={handleSave}
        loading={updatePayment.isPending}
        disabled={updatePayment.isPending}
        contentStyle={{ paddingVertical: 6 }}
        style={{ marginTop: 32, marginBottom: 32 }}
      >
        Save Changes
      </Button>
    </FormScreen>
  );
}
