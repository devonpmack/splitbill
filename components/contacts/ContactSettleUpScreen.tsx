import { useState } from "react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import {
  useContacts,
  useContactCurrency,
  useContactPairBalance,
} from "@/lib/queries/useContacts";
import {
  useContactPayments,
  useCreateContactPayment,
  useUpdateContactPayment,
} from "@/lib/queries/useContactPayments";
import { useAuth } from "@/lib/auth";
import { useDayPick } from "@/lib/useDayPick";
import { useHydrateOnce } from "@/lib/useHydrateOnce";
import {
  formatContactSettleLabel,
  getBalanceDirection,
  hasSignificantBalance,
} from "@/lib/balance-display";
import { getErrorMessage } from "@/lib/utils";
import { useSnackbar } from "@/lib/snackbar";
import { FormScreen } from "@/components/FormScreen";
import {
  ContactPaymentForm,
  type ContactPaymentDirection,
} from "@/components/contacts/ContactPaymentForm";

export function ContactSettleUpScreen() {
  const { contactUserId, paymentId, name } = useLocalSearchParams<{
    contactUserId: string;
    paymentId?: string;
    name?: string;
  }>();
  const isEdit = !!paymentId;
  const { user } = useAuth();
  const { data: contacts } = useContacts();
  const pairBalanceQuery = useContactPairBalance(contactUserId!);
  const pairBalance = pairBalanceQuery.data ?? 0;
  const { data: pairCurrency = "USD" } = useContactCurrency(contactUserId!);
  const { data: payments } = useContactPayments(contactUserId!);
  const createPayment = useCreateContactPayment();
  const updatePayment = useUpdateContactPayment();
  const { showError, showSuccess } = useSnackbar();

  const contact = contacts?.find((c) => c.contact_user_id === contactUserId);
  const contactName = contact?.full_name ?? name ?? "Contact";

  const [direction, setDirection] =
    useState<ContactPaymentDirection>("you_paid");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");

  const existingPayment = isEdit
    ? payments?.find((p) => p.id === paymentId)
    : undefined;
  const day = useDayPick(existingPayment?.date);

  // In create mode the prefill is derived from the pair balance, so it must
  // wait for that query -- hydrating against the default 0 forced the
  // direction to "you_paid" and booked settlements backwards.
  useHydrateOnce(
    isEdit ? !!existingPayment : pairBalanceQuery.isSuccess,
    () => {
      if (isEdit) {
        if (!existingPayment) return;
        setDirection(
          existingPayment.paid_by === user?.id ? "you_paid" : "they_paid"
        );
        setAmount(existingPayment.amount.toFixed(2));
        setNote(existingPayment.note ?? "");
        return;
      }

      // Create mode: default direction + amount from the current balance.
      // balance > 0 => contact owes you => they pay you to settle.
      setDirection(
        getBalanceDirection(pairBalance) === "owed" ? "they_paid" : "you_paid"
      );
      if (hasSignificantBalance(pairBalance)) {
        setAmount(Math.abs(pairBalance).toFixed(2));
      }
    }
  );

  const handleSubmit = async () => {
    const totalAmount = parseFloat(amount) || 0;
    if (totalAmount <= 0) {
      showError("Please enter a valid amount");
      return;
    }
    if (day.isInvalid) {
      showError("Please enter a valid date");
      return;
    }
    if (!user?.id || !contactUserId) {
      showError("Something went wrong. Please try again.");
      return;
    }

    const paidBy = direction === "you_paid" ? user.id : contactUserId;
    const paidTo = direction === "you_paid" ? contactUserId : user.id;

    try {
      if (isEdit && paymentId) {
        await updatePayment.mutateAsync({
          paymentId,
          contactUserId,
          paidBy,
          paidTo,
          amount: totalAmount,
          note: note.trim() || undefined,
          currency: pairCurrency,
          date: day.dateParam,
        });
        showSuccess("Payment updated!");
      } else {
        await createPayment.mutateAsync({
          contactUserId,
          paidBy,
          paidTo,
          amount: totalAmount,
          note: note.trim() || undefined,
          currency: pairCurrency,
          date: day.dateParam,
        });
        showSuccess("Payment recorded!");
      }
      router.back();
    } catch (error) {
      showError(
        getErrorMessage(error, "Couldn't record payment. Please try again.")
      );
    }
  };

  const isPending = isEdit ? updatePayment.isPending : createPayment.isPending;

  const balanceLabel = pairBalanceQuery.isSuccess
    ? formatContactSettleLabel(pairBalance, pairCurrency, contactName)
    : "Loading balance\u2026";

  return (
    <FormScreen
      header={
        <Stack.Screen
          options={{ title: isEdit ? "Edit Payment" : "Settle Up" }}
        />
      }
    >
      <ContactPaymentForm
          isEdit={isEdit}
          contactName={contactName}
          balanceLabel={balanceLabel}
          direction={direction}
          onDirectionChange={setDirection}
          amount={amount}
          onAmountChange={setAmount}
          note={note}
          onNoteChange={setNote}
          date={day.value}
          onDateChange={day.onChange}
          pairCurrency={pairCurrency}
          isPending={isPending}
          onSubmit={handleSubmit}
      />
    </FormScreen>
  );
}
