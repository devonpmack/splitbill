import { useRef, useState } from "react";
import { View } from "react-native";
import { HelperText } from "react-native-paper";
import {
  DatePickerInput,
  en,
  registerTranslation,
} from "react-native-paper-dates";
import {
  formatDay,
  isRolledOverMDY,
  isUpcoming,
  startOfLocalDayISO,
} from "@/lib/dates";
import { useAppTheme } from "@/lib/theme";

registerTranslation("en", en);

// Length of the "MM/DD/YYYY" mask the "en" locale uses.
const FULL_DATE_LENGTH = 10;
// Out-of-range days fail the library's own validation; this also catches a
// two-digit-looking year such as 0026, which Date turns into 1926.
const VALID_RANGE = {
  startDate: new Date(2000, 0, 1),
  endDate: new Date(2100, 11, 31),
};

type DateFieldProps = {
  // Undefined shows today. Null means the typed day is incomplete or invalid.
  value?: Date | null;
  onChange: (date: Date | null) => void;
  label?: string;
  testID?: string;
  // The "counts toward balances" note belongs to a transaction's date, not to
  // other dates such as where a repeat ends.
  showCountsHint?: boolean;
};

export function DateField({
  value,
  onChange,
  label = "Date",
  testID = "date-field",
  showCountsHint = true,
}: DateFieldProps) {
  const theme = useAppTheme();
  // The raw text of the latest keystroke. The library builds the day with
  // new Date(y, m - 1, d), which silently rolls 02/30 over to 03/02, so the
  // day it reports is checked against what was actually typed.
  const typedText = useRef<string | null>(null);
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
        validRange={VALID_RANGE}
        onChange={(date) => {
          const typed = typedText.current;
          typedText.current = null;
          if (date && typed && isRolledOverMDY(typed, date)) {
            onChange(null);
            return;
          }
          onChange(date ?? null);
        }}
        // Fired from the native change event, before the library parses.
        onChangeText={(text) => {
          typedText.current = text ?? null;
          if ((text ?? "").length < FULL_DATE_LENGTH) onChange(null);
        }}
        onValidationError={(error) => {
          if (!error) return;
          typedText.current = null;
          onChange(null);
        }}
        testID={testID}
      />
      {isFuture && showCountsHint ? (
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
