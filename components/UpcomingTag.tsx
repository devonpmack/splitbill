import { View } from "react-native";
import { Text } from "react-native-paper";
import { useAppTheme } from "@/lib/theme";

// Marks a row dated in the future: it does not count toward balances yet. A
// plain badge, not a Chip, so it is not announced as a button.
export function UpcomingTag() {
  const theme = useAppTheme();

  return (
    <View
      accessible
      accessibilityRole="text"
      style={{
        alignSelf: "flex-start",
        backgroundColor: theme.colors.primaryContainer,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 3,
      }}
    >
      <Text
        variant="labelSmall"
        style={{ color: theme.colors.onPrimaryContainer }}
      >
        Upcoming
      </Text>
    </View>
  );
}
