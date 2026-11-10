import { Chip } from "react-native-paper";
import { useScheduleFrequencies } from "@/lib/queries/useRecurringSchedules";
import { hidesChip, repeatsPhrase } from "@/lib/recurrence";
import { useAppTheme } from "@/lib/theme";

// Marks an occurrence of a recurring expense. Renders nothing until the
// schedule has loaded, nor on an upcoming row that a stopped schedule left
// behind (it will never repeat).
export function RepeatsTag({
  scheduleId,
  upcoming,
}: {
  scheduleId: string;
  upcoming: boolean;
}) {
  const theme = useAppTheme();
  const { data: schedules } = useScheduleFrequencies();
  const schedule = schedules?.[scheduleId];
  if (!schedule || hidesChip(schedule, upcoming)) return null;

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
      {`Repeats ${repeatsPhrase(schedule.frequency)}`}
    </Chip>
  );
}
