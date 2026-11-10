import { View, ScrollView } from "react-native";
import { Card, Divider, List, Text } from "react-native-paper";
import { useNotificationPrefs } from "@/lib/notifications";
import { useAppTheme } from "@/lib/theme";
import { LoadingScreen } from "@/components/LoadingScreen";
import { NotificationToggleItem } from "@/components/account/NotificationToggleItem";

export default function Notifications() {
  const theme = useAppTheme();
  const { prefs, setPref, loading } = useNotificationPrefs();

  if (loading) {
    return <LoadingScreen />;
  }

  const pushOff = !prefs.pushEnabled;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.background }}
    >
      <View style={{ paddingHorizontal: 24, paddingTop: 16 }}>
        <List.Subheader>General</List.Subheader>
        <Card mode="contained">
          <NotificationToggleItem
            title="Push Notifications"
            description="Turn all notifications on or off"
            icon="bell-outline"
            value={prefs.pushEnabled}
            onValueChange={(value: boolean) => setPref("pushEnabled", value)}
          />
        </Card>

        <List.Subheader style={{ marginTop: 16 }}>Activity</List.Subheader>
        <Card mode="contained">
          <NotificationToggleItem
            title="New Expenses"
            description="When someone adds an expense"
            icon="receipt"
            value={prefs.newExpenses}
            onValueChange={(value: boolean) => setPref("newExpenses", value)}
            disabled={pushOff}
          />
          <Divider />
          <NotificationToggleItem
            title="Settlements"
            description="When a payment is recorded"
            icon="check-circle-outline"
            value={prefs.settlements}
            onValueChange={(value: boolean) => setPref("settlements", value)}
            disabled={pushOff}
          />
          <Divider />
          <NotificationToggleItem
            title="Group Invites"
            description="When you're added to a group"
            icon="account-group-outline"
            value={prefs.groupInvites}
            onValueChange={(value: boolean) => setPref("groupInvites", value)}
            disabled={pushOff}
          />
          <Divider />
          <NotificationToggleItem
            title="Payment Reminders"
            description="Periodic reminders for unsettled balances"
            icon="alarm"
            value={prefs.paymentReminders}
            onValueChange={(value: boolean) => setPref("paymentReminders", value)}
            disabled={pushOff}
          />
        </Card>

        <Text
          variant="bodySmall"
          style={{
            color: theme.colors.onSurfaceVariant,
            marginTop: 24,
            marginBottom: 24,
            paddingHorizontal: 4,
            lineHeight: 20,
          }}
        >
          Notification preferences are stored on this device and control which
          alerts Splitfox sends you.
        </Text>
      </View>
    </ScrollView>
  );
}
