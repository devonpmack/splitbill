import { Chip } from "react-native-paper";
import { useScheduleFrequencies } from "@/lib/queries/useRecurringSchedules";
import { repeatsPhrase } from "@/lib/recurrence";
import { useAppTheme } from "@/lib/theme";

// Marks an occurrence of a recurring expense. Renders nothing until the
// schedule's frequency has loaded.
export function RepeatsTag({ scheduleId }: { scheduleId: string }) {
  const theme = useAppTheme();
  const { data: frequencies } = useScheduleFrequencies();
  const frequency = frequencies?.[scheduleId];
  if (!frequency) return null;

  return (
    <Chip
      compact
      mode="flat"
      icon="repeat"
      style={{
        alignSelf: "flex-start",
        backgroundColor: theme.colors.secondaryContainer,
      }}
      textStyle={{
        color: theme.colors.onSecondaryContainer,
        fontSize: 11,
        lineHeight: 14,
        marginVertical: 2,
      }}
    >
      {`Repeats ${repeatsPhrase(frequency)}`}
    </Chip>
  );
}
