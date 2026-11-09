import { useState } from "react";
import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { Button, Divider, Switch, Text, TextInput } from "react-native-paper";
import {
  useGroup,
  useRenameGroup,
  useSetGroupSimplifyDebts,
} from "@/lib/queries/useGroups";
import { useHydrateOnce } from "@/lib/useHydrateOnce";
import { useSnackbar } from "@/lib/snackbar";
import { useAppTheme } from "@/lib/theme";
import { getErrorMessage } from "@/lib/utils";
import { FormScreen } from "@/components/FormScreen";

export default function ManageGroup() {
  const theme = useAppTheme();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { data: group } = useGroup(groupId!);

  const [name, setName] = useState("");
  // useState's initializer only runs on the first render, so seeding it from
  // the query left the field permanently blank whenever the group wasn't
  // already cached (deep link, or after cache eviction).
  useHydrateOnce(!!group, () => setName(group?.name ?? ""));

  const renameGroup = useRenameGroup();
  const setSimplifyDebts = useSetGroupSimplifyDebts();
  const { showError, showSuccess } = useSnackbar();

  const simplifyEnabled = group?.simplify_debts ?? true;

  const handleToggleSimplify = async (enabled: boolean) => {
    try {
      await setSimplifyDebts.mutateAsync({ groupId: groupId!, enabled });
      showSuccess(enabled ? "Debt simplification on" : "Debt simplification off");
    } catch (error) {
      showError(
        getErrorMessage(error, "Couldn't update the setting. Please try again.")
      );
    }
  };

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      showError("Please enter a group name");
      return;
    }
    if (trimmed === group?.name) {
      showError("That's already the group name");
      return;
    }
    try {
      await renameGroup.mutateAsync({ groupId: groupId!, name: trimmed });
      showSuccess("Group renamed");
    } catch (error) {
      showError(
        getErrorMessage(error, "Couldn't rename the group. Please try again.")
      );
    }
  };

  return (
    <FormScreen>
      <Text
        variant="titleMedium"
        style={{ fontWeight: "bold", marginBottom: 12 }}
      >
        Group name
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <TextInput
          mode="outlined"
          label="Group Name"
          value={name}
          onChangeText={setName}
          style={{ flex: 1 }}
        />
      </View>
      <Button
        mode="contained"
        onPress={handleRename}
        loading={renameGroup.isPending}
        disabled={renameGroup.isPending}
        contentStyle={{ paddingVertical: 4 }}
        style={{ marginTop: 16, alignSelf: "flex-start" }}
      >
        Save Name
      </Button>

      <Divider style={{ marginVertical: 24 }} />

      <Text
        variant="titleMedium"
        style={{ fontWeight: "bold", marginBottom: 12 }}
      >
        Balances
      </Text>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <View style={{ flex: 1 }}>
          <Text variant="bodyLarge" style={{ color: theme.colors.onSurface }}>
            Simplify group debts
          </Text>
          <Text
            variant="bodySmall"
            style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
          >
            Combine debts to show the fewest payments. Turn off to see exactly
            who owes whom.
          </Text>
        </View>
        <Switch
          value={simplifyEnabled}
          onValueChange={handleToggleSimplify}
          disabled={!group || setSimplifyDebts.isPending}
          color={theme.colors.primary}
        />
      </View>
      <Text
        variant="bodySmall"
        style={{
          color: theme.colors.onSurfaceVariant,
          marginTop: 16,
          lineHeight: 20,
        }}
      >
        When simplify debts is on, Evenpot nets out chains of IOUs so the
        group settles in the fewest possible payments. For example, if Alice
        owes Bob $10 and Bob owes Carol $10, Evenpot collapses that into Alice
        paying Carol $10 directly — Bob no longer needs to be involved. Your net
        balance (the total you owe or are owed across the group) is exactly the
        same either way; simplification only changes who pays whom, not how
        much. Turn it off to see the exact person-to-person amounts from each
        individual expense.
      </Text>
    </FormScreen>
  );
}
