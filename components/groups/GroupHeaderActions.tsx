import { View, Pressable } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useAppTheme } from "@/lib/theme";
import { RepeatingHeaderButton } from "@/components/recurring/RepeatingHeaderButton";

type GroupHeaderActionsProps = {
  onSettings: () => void;
  onRepeating: () => void;
  onLeave: () => void;
};

export function GroupHeaderActions({
  onSettings,
  onRepeating,
  onLeave,
}: GroupHeaderActionsProps) {
  const theme = useAppTheme();

  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <Pressable
        role="button"
        accessibilityLabel="Group settings"
        onPress={onSettings}
        hitSlop={8}
        style={{ paddingHorizontal: 8 }}
      >
        <MaterialCommunityIcons
          name="cog-outline"
          size={22}
          color={theme.colors.onPrimary}
        />
      </Pressable>
      <RepeatingHeaderButton onPress={onRepeating} />
      <Pressable
        role="button"
        accessibilityLabel="Leave group"
        onPress={onLeave}
        hitSlop={8}
        style={{ paddingHorizontal: 8 }}
      >
        <MaterialCommunityIcons
          name="logout"
          size={22}
          color={theme.colors.onPrimary}
        />
      </Pressable>
    </View>
  );
}
