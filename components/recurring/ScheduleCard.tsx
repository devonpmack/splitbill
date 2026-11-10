import { View } from "react-native";
import { Button, Card, Text } from "react-native-paper";
import { formatCalendarDay } from "@/lib/dates";
import {
  endSummary,
  frequencyLabel,
  nextOccurrenceFrom,
  stopReasonLabel,
} from "@/lib/recurrence";
import { useAppTheme } from "@/lib/theme";
import { formatCurrency } from "@/lib/utils";
import type { RecurringSchedule } from "@/lib/types";

type ScheduleCardProps = {
  schedule: RecurringSchedule;
  payerName: string;
  onStop: (schedule: RecurringSchedule) => void;
  stopDisabled?: boolean;
};

export function ScheduleCard({
  schedule,
  payerName,
  onStop,
  stopDisabled,
}: ScheduleCardProps) {
  const theme = useAppTheme();
  const isActive = schedule.stopped_at === null;
  const next = nextOccurrenceFrom(schedule, new Date());
  const muted = { color: theme.colors.onSurfaceVariant };

  return (
    <Card mode="elevated">
      <Card.Content>
        <Text variant="titleMedium" style={{ fontWeight: "600" }}>
          {schedule.description}
        </Text>
        <Text variant="bodyMedium" style={{ marginTop: 2 }}>
          {`${formatCurrency(schedule.amount, schedule.currency)} · ${frequencyLabel(schedule.frequency)}`}
        </Text>
        <Text variant="bodySmall" style={[muted, { marginTop: 2 }]}>
          {`Paid by ${payerName}`}
        </Text>

        <View style={{ marginTop: 8, gap: 2 }}>
          {isActive ? (
            <>
              {next ? (
                <Text variant="bodySmall" style={muted}>
                  {`Next: ${formatCalendarDay(next.date)}`}
                </Text>
              ) : null}
              <Text variant="bodySmall" style={muted}>
                {endSummary(schedule, next)}
              </Text>
              {schedule.failed_runs > 0 ? (
                <Text variant="bodySmall" style={{ color: theme.colors.error }}>
                  The latest repeat could not be created. Trying again.
                </Text>
              ) : null}
            </>
          ) : (
            <Text variant="bodySmall" style={muted}>
              {stopReasonLabel(schedule.stop_reason)}
            </Text>
          )}
        </View>

        {isActive ? (
          <View style={{ alignItems: "flex-end", marginTop: 4 }}>
            <Button
              compact
              textColor={theme.colors.error}
              onPress={() => onStop(schedule)}
              disabled={stopDisabled}
            >
              Stop
            </Button>
          </View>
        ) : null}
      </Card.Content>
    </Card>
  );
}
