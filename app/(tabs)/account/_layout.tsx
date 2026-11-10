import { Stack } from "expo-router";
import { useAppTheme } from "@/lib/theme";

export default function AccountLayout() {
  const theme = useAppTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.brand },
        headerTintColor: theme.colors.onBrand,
        headerTitleStyle: { fontWeight: "bold" },
        contentStyle: { backgroundColor: theme.colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ title: "Account" }} />
      <Stack.Screen name="edit-profile" options={{ title: "Edit Profile" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="help" options={{ title: "Help & Support" }} />
      <Stack.Screen
        name="delete-account"
        options={{ title: "Delete Account" }}
      />
    </Stack>
  );
}
