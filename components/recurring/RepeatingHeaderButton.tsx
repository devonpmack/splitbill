import { Pressable } from "react-native";
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { useAppTheme } from "@/lib/theme";

// Header action that opens the Repeating list of a group or contact.
export function RepeatingHeaderButton({ onPress }: { onPress: () => void }) {
  const theme = useAppTheme();

  return (
    <Pressable
      role="button"
      accessibilityLabel="Repeating"
      onPress={onPress}
      hitSlop={8}
      style={{ paddingHorizontal: 8 }}
    >
      <MaterialCommunityIcons
        name="repeat"
        size={22}
        color={theme.colors.onPrimary}
      />
    </Pressable>
  );
}
