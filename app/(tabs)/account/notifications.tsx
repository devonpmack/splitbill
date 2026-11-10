import { View } from "react-native";
import { Text } from "react-native-paper";
import { useAppTheme } from "@/lib/theme";
import { APP_NAME } from "@/lib/app-name";

// Nothing sends push notifications yet, so the old preference switches only
// saved a local setting and implied alerts that never come.
export default function Notifications() {
  const theme = useAppTheme();

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.colors.background,
        justifyContent: "center",
        paddingHorizontal: 32,
      }}
    >
      <Text
        variant="titleMedium"
        style={{ textAlign: "center", color: theme.colors.onSurface }}
      >
        Notifications are coming soon
      </Text>
      <Text
        variant="bodyMedium"
        style={{
          textAlign: "center",
          marginTop: 8,
          color: theme.colors.onSurfaceVariant,
        }}
      >
        {APP_NAME} doesn&apos;t send push notifications yet.
      </Text>
    </View>
  );
}
