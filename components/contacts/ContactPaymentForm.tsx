import { Button, SegmentedButtons, Text } from "react-native-paper";
import { PaymentAmountNoteFields } from "@/components/PaymentAmountNoteFields";
import { useAppTheme } from "@/lib/theme";

export type ContactPaymentDirection = "you_paid" | "they_paid";

type ContactPaymentFormProps = {
  isEdit: boolean;
  contactName: string;
  balanceLabel: string;
  direction: ContactPaymentDirection;
  onDirectionChange: (direction: ContactPaymentDirection) => void;
  amount: string;
  onAmountChange: (amount: string) => void;
  note: string;
  onNoteChange: (note: string) => void;
  date: Date | null | undefined;
  onDateChange: (date: Date | null) => void;
  pairCurrency: string;
  isPending: boolean;
  onSubmit: () => void;
};

export function ContactPaymentForm({
  isEdit,
  contactName,
  balanceLabel,
  direction,
  onDirectionChange,
  amount,
  onAmountChange,
  note,
  onNoteChange,
  date,
  onDateChange,
  pairCurrency,
  isPending,
  onSubmit,
}: ContactPaymentFormProps) {
  const theme = useAppTheme();

  return (
    <>
      {!isEdit && (
        <Text
          variant="bodyMedium"
          style={{ color: theme.colors.onSurfaceVariant, marginBottom: 16 }}
        >
          {balanceLabel}
        </Text>
      )}

      <Text
        variant="labelLarge"
        style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}
      >
        Who paid?
      </Text>
      <SegmentedButtons
        value={direction}
        onValueChange={(next) =>
          onDirectionChange(next as ContactPaymentDirection)
        }
        buttons={[
          { value: "you_paid", label: `You paid ${contactName}` },
          { value: "they_paid", label: `${contactName} paid you` },
        ]}
      />

      <PaymentAmountNoteFields
        amount={amount}
        onAmountChange={onAmountChange}
        note={note}
        onNoteChange={onNoteChange}
        date={date}
        onDateChange={onDateChange}
        currency={pairCurrency}
      />

      <Button
        mode="contained"
        buttonColor={theme.colors.secondary}
        textColor={theme.colors.onSecondary}
        onPress={onSubmit}
        loading={isPending}
        disabled={isPending}
        contentStyle={{ paddingVertical: 6 }}
        style={{ marginTop: 32, marginBottom: 32 }}
      >
        {isEdit ? "Save Changes" : "Record Payment"}
      </Button>
    </>
  );
}
