import { View } from "react-native";
import {
  Chip,
  HelperText,
  SegmentedButtons,
  Text,
  TextInput,
} from "react-native-paper";
import { DateField } from "@/components/DateField";
import {
  FREQUENCIES,
  frequencyLabel,
  REPEAT_COUNT_ERROR,
  type RepeatEnds,
} from "@/lib/recurrence";
import { useAppTheme } from "@/lib/theme";
import type { RecurringFrequency } from "@/lib/types";

const RATE_NOTE =
  "Later repeats use the exchange rate on the day each one is created (the last known rate if none is available).";

type RepeatFieldsProps = {
  // Null means the expense does not repeat.
  frequency: RecurringFrequency | null;
  onFrequencyChange: (frequency: RecurringFrequency | null) => void;
  ends: RepeatEnds;
  onEndsChange: (ends: RepeatEnds) => void;
  // Null means the typed day is incomplete or invalid.
  endDay: Date | null;
  onEndDayChange: (day: Date | null) => void;
  count: string;
  onCountChange: (count: string) => void;
  // The expense is in a currency other than the group's or pair's.
  isForeignCurrency: boolean;
  // False when the count is not a whole number from 1 to the cap.
  countIsValid: boolean;
  // Where an "After N times" series ends, once the count is valid.
  lastOccurrenceLabel?: string;
};

export function RepeatFields({
  frequency,
  onFrequencyChange,
  ends,
  onEndsChange,
  endDay,
  onEndDayChange,
  count,
  onCountChange,
  isForeignCurrency,
  countIsValid,
  lastOccurrenceLabel,
}: RepeatFieldsProps) {
  const theme = useAppTheme();

  return (
    <View style={{ marginTop: 24 }}>
      <Text
        variant="labelLarge"
        style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}
      >
        Repeat
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="Repeat frequency"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
      >
        {[null, ...FREQUENCIES].map((option) => {
          const label = option ? frequencyLabel(option) : "Does not repeat";
          return (
            <Chip
              key={option ?? "none"}
              mode="outlined"
              accessibilityRole="radio"
              accessibilityLabel={label}
              selected={frequency === option}
              onPress={() => onFrequencyChange(option)}
            >
              {label}
            </Chip>
          );
        })}
      </View>

      {frequency && isForeignCurrency ? (
        <Text
          variant="bodySmall"
          style={{ color: theme.colors.onSurfaceVariant, marginTop: 8 }}
        >
          {RATE_NOTE}
        </Text>
      ) : null}

      {frequency ? (
        <View style={{ marginTop: 16 }}>
          <Text
            variant="labelLarge"
            style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}
          >
            Ends
          </Text>
          <View accessibilityRole="radiogroup" accessibilityLabel="Ends">
            <SegmentedButtons
              value={ends}
              onValueChange={(next) => onEndsChange(next as RepeatEnds)}
              buttons={[
                { value: "never", label: "Never" },
                { value: "date", label: "On date" },
                { value: "count", label: "After" },
              ]}
            />
          </View>
          {ends === "date" ? (
            <DateField
              value={endDay}
              onChange={onEndDayChange}
              label="End date"
              testID="end-date-field"
              showCountsHint={false}
            />
          ) : null}
          {ends === "count" ? (
            <>
              <TextInput
                mode="outlined"
                label="Number of times"
                accessibilityLabel="Number of times"
                value={count}
                onChangeText={onCountChange}
                keyboardType="number-pad"
                error={!countIsValid}
                style={{ marginTop: 16 }}
              />
              {countIsValid ? null : (
                <HelperText type="error">{REPEAT_COUNT_ERROR}</HelperText>
              )}
              {lastOccurrenceLabel ? (
                <Text
                  variant="bodySmall"
                  style={{
                    color: theme.colors.onSurfaceVariant,
                    marginTop: 8,
                  }}
                >
                  {lastOccurrenceLabel}
                </Text>
              ) : null}
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
