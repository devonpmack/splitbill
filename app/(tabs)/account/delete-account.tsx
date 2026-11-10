import { useState } from "react";
import { View } from "react-native";
import {
  ActivityIndicator,
  Button,
  Card,
  Checkbox,
  Text,
  TextInput,
  TouchableRipple,
} from "react-native-paper";
import { useAuth } from "@/lib/auth";
import { getBalanceColor } from "@/lib/balance-display";
import { canDeleteAccount } from "@/lib/delete-account";
import {
  useDeleteAccount,
  useMyOpenBalances,
} from "@/lib/queries/useDeleteAccount";
import { useAppTheme } from "@/lib/theme";
import { formatCurrency, getErrorMessage } from "@/lib/utils";
import { FormScreen } from "@/components/FormScreen";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={{ marginBottom: 24 }}>
      <Text variant="titleMedium" style={{ fontWeight: "bold", marginBottom: 8 }}>
        {title}
      </Text>
      {children}
    </View>
  );
}

export default function DeleteAccount() {
  const theme = useAppTheme();
  const { signOut } = useAuth();
  const deleteAccount = useDeleteAccount();
  const balances = useMyOpenBalances();

  const [acknowledged, setAcknowledged] = useState(false);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  const canDelete = canDeleteAccount(acknowledged, typed);

  const handleDelete = async () => {
    if (!canDelete || deleteAccount.isPending) return;
    setError(null);
    try {
      await deleteAccount.mutateAsync();
      // Signed out: the tabs layout moves us to sign-in, so nothing else to do.
    } catch (e) {
      setError(
        getErrorMessage(e, "Couldn't delete your account. Please try again.")
      );
    }
  };

  const muted = { color: theme.colors.onSurfaceVariant };

  return (
    <FormScreen paddingTop={24}>
      <Section title="What gets deleted">
        <Text variant="bodyMedium">
          Your name, picture and email, and your sign-in. People can no longer
          find you by email. Groups with no one else in them are deleted,
          repeating expenses you are part of stop, and expenses and payments
          dated in the future that involve you are removed.
        </Text>
      </Section>

      <Section title="What stays">
        <Text variant="bodyMedium">
          Expenses and payments you took part in stay for the other people in
          those groups, so nobody else's balance changes. Your name on them is
          shown as "Deleted user". The amounts and descriptions you typed stay
          too. Balances with individual people stay on their ledger.
        </Text>
      </Section>

      <Section title="Your open balances in groups">
        {balances.isPending ? (
          <ActivityIndicator />
        ) : balances.isError ? (
          <Text variant="bodyMedium" style={muted}>
            We couldn't load your balances, but you can still delete your
            account.
          </Text>
        ) : (balances.data ?? []).length === 0 ? (
          <Text variant="bodyMedium" style={muted}>
            You have no open balances in groups.
          </Text>
        ) : (
          <Card mode="contained">
            {(balances.data ?? []).map((row) => (
              <Card.Content
                key={row.groupId}
                style={{
                  flexDirection: "row",
                  justifyContent: "space-between",
                  paddingVertical: 10,
                }}
              >
                <Text variant="bodyMedium">{row.groupName}</Text>
                <Text
                  variant="bodyMedium"
                  style={{
                    color: getBalanceColor(row.balance, theme.colors),
                  }}
                >
                  {row.balance < 0
                    ? `you owe ${formatCurrency(Math.abs(row.balance), row.currency)}`
                    : `you are owed ${formatCurrency(row.balance, row.currency)}`}
                </Text>
              </Card.Content>
            ))}
          </Card>
        )}
        <Text variant="bodySmall" style={[muted, { marginTop: 8 }]}>
          These amounts stay owed after your account is deleted. Balances with
          individual people are not listed here; they stay too. Settling up
          first is up to you.
        </Text>
      </Section>

      <TouchableRipple
        onPress={() => setAcknowledged((v) => !v)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: acknowledged }}
        accessibilityLabel="I understand this can't be undone"
      >
        <View
          style={{ flexDirection: "row", alignItems: "center", paddingVertical: 4 }}
        >
          <View
            pointerEvents="none"
            importantForAccessibility="no-hide-descendants"
            accessibilityElementsHidden
          >
            <Checkbox status={acknowledged ? "checked" : "unchecked"} />
          </View>
          <Text
            variant="bodyMedium"
            style={{ flex: 1, marginLeft: 4, textAlign: "left" }}
          >
            I understand this can't be undone
          </Text>
        </View>
      </TouchableRipple>

      <TextInput
        mode="outlined"
        label="Type DELETE to confirm"
        placeholder="Type DELETE"
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        style={{ marginTop: 8 }}
      />

      {error ? (
        <View style={{ marginTop: 16 }}>
          <Text variant="bodyMedium" style={{ color: theme.colors.error }}>
            {error}
          </Text>
          <Button
            mode="outlined"
            onPress={signOut}
            style={{ marginTop: 12 }}
          >
            Sign out
          </Button>
        </View>
      ) : null}

      <Button
        mode="contained"
        buttonColor={theme.colors.error}
        textColor={theme.colors.onError}
        onPress={handleDelete}
        disabled={!canDelete || deleteAccount.isPending}
        loading={deleteAccount.isPending}
        contentStyle={{ paddingVertical: 6 }}
        style={{ marginTop: 24, marginBottom: 48 }}
      >
        Delete my account
      </Button>
    </FormScreen>
  );
}
