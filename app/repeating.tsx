import { ScrollView, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { List } from "react-native-paper";
import { useAuth } from "@/lib/auth";
import { useConfirm } from "@/lib/confirm";
import { useContacts } from "@/lib/queries/useContacts";
import { useGroup } from "@/lib/queries/useGroups";
import {
  useRecurringSchedules,
  useStopRecurringSchedule,
  type ScheduleScope,
} from "@/lib/queries/useRecurringSchedules";
import { useSnackbar } from "@/lib/snackbar";
import { useAppTheme } from "@/lib/theme";
import { getErrorMessage } from "@/lib/utils";
import type { RecurringSchedule } from "@/lib/types";
import { EmptyState } from "@/components/EmptyState";
import { ScheduleCard } from "@/components/recurring/ScheduleCard";

export default function Repeating() {
  const theme = useAppTheme();
  const { groupId, contactUserId } = useLocalSearchParams<{
    groupId?: string;
    contactUserId?: string;
  }>();
  const scope: ScheduleScope = groupId
    ? { kind: "group", groupId }
    : { kind: "contact", contactUserId: contactUserId ?? "" };

  const { user } = useAuth();
  const { data: schedules } = useRecurringSchedules(scope);
  const { data: group } = useGroup(groupId ?? "");
  const { data: contacts } = useContacts();
  const stopSchedule = useStopRecurringSchedule();
  const { showError, showSuccess } = useSnackbar();
  const confirm = useConfirm();

  const payerName = (userId: string) => {
    if (userId === user?.id) return "You";
    const memberName = group?.group_members.find((m) => m.user_id === userId)
      ?.profiles?.full_name;
    const contactName = contacts?.find(
      (c) => c.contact_user_id === userId
    )?.full_name;
    return memberName ?? contactName ?? "Someone";
  };

  const handleStop = (schedule: RecurringSchedule) => {
    if (stopSchedule.isPending) return;
    confirm({
      title: `Stop repeating "${schedule.description}"?`,
      message:
        "Future repeats that were created ahead of time will be removed. Past ones stay. Edited ones stay.",
      confirmText: "Stop",
      destructive: true,
      onConfirm: () => {
        stopSchedule.mutate(
          { scheduleId: schedule.id, scope },
          {
            onSuccess: () => showSuccess("Stopped repeating"),
            onError: (error) =>
              showError(
                getErrorMessage(
                  error,
                  "Couldn't stop the repeat. Please try again."
                )
              ),
          }
        );
      },
    });
  };

  const active = (schedules ?? []).filter((s) => s.stopped_at === null);
  const stopped = (schedules ?? []).filter((s) => s.stopped_at !== null);

  const card = (schedule: RecurringSchedule) => (
    <ScheduleCard
      key={schedule.id}
      schedule={schedule}
      payerName={payerName(schedule.paid_by)}
      onStop={handleStop}
      stopDisabled={stopSchedule.isPending}
    />
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
      contentContainerStyle={{ padding: 16, gap: 12 }}
    >
      {active.map(card)}

      {schedules && active.length === 0 ? (
        <EmptyState
          icon="repeat"
          title="Nothing repeats yet"
          subtitle="Pick a repeat when adding an expense to set one up."
        />
      ) : null}

      {stopped.length > 0 ? (
        <View style={{ marginTop: 8 }}>
          <List.Accordion
            title={`Stopped (${stopped.length})`}
            style={{ backgroundColor: theme.colors.background, paddingLeft: 0 }}
          >
            <View style={{ gap: 12, paddingTop: 8 }}>{stopped.map(card)}</View>
          </List.Accordion>
        </View>
      ) : null}
    </ScrollView>
  );
}
