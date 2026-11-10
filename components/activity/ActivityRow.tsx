import { View } from "react-native";
import { Card, IconButton, Text } from "react-native-paper";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useAppTheme } from "@/lib/theme";
import { formatDay, rowDay } from "@/lib/dates";
import { UpcomingTag } from "@/components/UpcomingTag";
import { RepeatsTag } from "@/components/RepeatsTag";
import type { ComponentProps } from "react";

type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

// The right-hand block: a two-line summary with its own colour (expenses), a
// single bold amount (payments), or muted text when the user isn't involved.
export type ActivityRowTrailing =
  | { kind: "summary"; label: string; text: string; color: string }
  | { kind: "amount"; text: string }
  | { kind: "muted"; text: string };

type ActivityRowProps = {
  // "secondary" is the filled treatment used for payments.
  tone?: "surface" | "secondary";
  icon: IconName;
  title: string;
  subtitle?: string;
  note?: string | null;
  // ISO timestamp shown in the footer.
  date: string;
  onPress: () => void;
  trailing?: ActivityRowTrailing;
  edit?: { label: string; onPress: () => void };
  // Dated in the future: tagged, and the footer says when it starts counting.
  upcoming?: boolean;
  // An occurrence of a recurring expense: tagged, and dated by the schedule's
  // calendar day rather than the instant in this device's zone.
  scheduleId?: string | null;
  occurrenceDate?: string | null;
};

export function ActivityRow({
  tone = "surface",
  icon,
  title,
  subtitle,
  note,
  date,
  onPress,
  trailing,
  edit,
  upcoming,
  scheduleId,
  occurrenceDate,
}: ActivityRowProps) {
  const theme = useAppTheme();
  const day = rowDay(date, occurrenceDate);
  const isSecondary = tone === "secondary";
  const onTone = isSecondary
    ? theme.colors.onSecondaryContainer
    : theme.colors.onSurfaceVariant;
  const titleColor = isSecondary
    ? theme.colors.onSecondaryContainer
    : undefined;

  return (
    <Card
      mode={isSecondary ? "contained" : "elevated"}
      style={{
        marginBottom: 12,
        ...(isSecondary
          ? { backgroundColor: theme.colors.secondaryContainer }
          : {}),
      }}
      onPress={onPress}
    >
      <Card.Content>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <View
            style={{ flexDirection: "row", alignItems: "center", flex: 1 }}
          >
            <MaterialCommunityIcons
              name={icon}
              size={22}
              color={onTone}
              style={{ marginRight: 10 }}
            />
            <View style={{ flex: 1 }}>
              <Text
                variant="titleMedium"
                style={{ fontWeight: "600", color: titleColor }}
              >
                {title}
              </Text>
              {subtitle ? (
                <Text variant="bodySmall" style={{ color: onTone }}>
                  {subtitle}
                </Text>
              ) : null}
            </View>
          </View>

          {trailing || edit ? (
            <View style={{ flexDirection: "row", alignItems: "center" }}>
              {trailing ? <Trailing trailing={trailing} tone={onTone} /> : null}
              {edit ? (
                <IconButton
                  icon="pencil-outline"
                  size={18}
                  iconColor={isSecondary ? onTone : undefined}
                  accessibilityLabel={edit.label}
                  onPress={edit.onPress}
                  style={{ margin: 0, marginLeft: 4 }}
                />
              ) : null}
            </View>
          ) : null}
        </View>

        {note ? (
          <Text variant="bodySmall" style={{ color: onTone, marginTop: 8 }}>
            {note}
          </Text>
        ) : null}

        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            marginTop: 8,
          }}
        >
          {upcoming ? <UpcomingTag /> : null}
          {scheduleId ? <RepeatsTag scheduleId={scheduleId} /> : null}
          <Text variant="labelSmall" style={{ color: onTone }}>
            {upcoming ? `Counts from ${formatDay(day)}` : formatDay(day)}
          </Text>
        </View>
      </Card.Content>
    </Card>
  );
}

function Trailing({
  trailing,
  tone,
}: {
  trailing: ActivityRowTrailing;
  tone: string;
}) {
  if (trailing.kind === "muted") {
    return (
      <Text variant="bodySmall" style={{ color: tone }}>
        {trailing.text}
      </Text>
    );
  }

  if (trailing.kind === "amount") {
    return (
      <Text variant="titleMedium" style={{ fontWeight: "bold", color: tone }}>
        {trailing.text}
      </Text>
    );
  }

  return (
    <View style={{ alignItems: "flex-end" }}>
      <Text variant="labelSmall" style={{ color: trailing.color }}>
        {trailing.label}
      </Text>
      <Text
        variant="titleMedium"
        style={{ fontWeight: "bold", color: trailing.color }}
      >
        {trailing.text}
      </Text>
    </View>
  );
}
