import { useState } from "react";
import { View } from "react-native";
import { HelperText } from "react-native-paper";
import {
  DatePickerInput,
  en,
  registerTranslation,
} from "react-native-paper-dates";
import { formatDay, isUpcoming, startOfLocalDayISO } from "@/lib/dates";
import { useAppTheme } from "@/lib/theme";

registerTranslation("en", en);

// Length of the "MM/DD/YYYY" mask the "en" locale uses.
const FULL_DATE_LENGTH = 10;

type DateFieldProps = {
  // Undefined shows today. Null means the typed day is incomplete or invalid.
  value?: Date | null;
  onChange: (date: Date | null) => void;
  label?: string;
  testID?: string;
};

export function DateField({
  value,
  onChange,
  label = "Date",
  testID = "date-field",
}: DateFieldProps) {
  const theme = useAppTheme();
  const [lastValid, setLastValid] = useState<Date>(() => value ?? new Date());
  if (value && value.getTime() !== lastValid.getTime()) setLastValid(value);

  const chosen = value === undefined ? lastValid : value;
  const isFuture = !!chosen && isUpcoming(startOfLocalDayISO(chosen));

  return (
    <View style={{ marginTop: 16 }}>
      <DatePickerInput
        mode="outlined"
        locale="en"
        label={label}
        inputMode="start"
        // The picker only reports complete days, so while the parent holds
        // null the last valid day stays here and the typed text is kept.
        value={chosen ?? lastValid}
        onChange={(date) => onChange(date ?? null)}
        onChangeText={(text) => {
          if ((text ?? "").length < FULL_DATE_LENGTH) onChange(null);
        }}
        onValidationError={(error) => {
          if (error) onChange(null);
        }}
        testID={testID}
      />
      {isFuture ? (
        <HelperText
          type="info"
          style={{ color: theme.colors.onSurfaceVariant }}
        >
          {`Counts toward balances from ${formatDay(chosen)}.`}
        </HelperText>
      ) : null}
    </View>
  );
}
