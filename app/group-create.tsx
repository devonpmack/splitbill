import { useState } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { Button, Text, TextInput } from "react-native-paper";
import { useCheckEmailExists, useCreateGroup } from "@/lib/queries/useGroups";
import { useSnackbar } from "@/lib/snackbar";
import { useAppTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { getErrorMessage } from "@/lib/utils";
import { MemberEmailInput } from "@/components/groups/MemberEmailInput";
import { CurrencyPicker } from "@/components/CurrencyPicker";
import { FormScreen } from "@/components/FormScreen";
import { useDisplayCurrency } from "@/lib/display-currency";
import { APP_NAME } from "@/lib/app-name";

export default function CreateGroup() {
  const theme = useAppTheme();
  const { user } = useAuth();
  const { currency: displayCurrency } = useDisplayCurrency();
  const [name, setName] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const [memberEmails, setMemberEmails] = useState<string[]>([]);
  const [selectedCurrency, setSelectedCurrency] = useState<string | null>(null);
  const currency = selectedCurrency ?? displayCurrency;
  const createGroup = useCreateGroup();
  const checkEmail = useCheckEmailExists();
  const { showError } = useSnackbar();

  const validatePendingEmail = async (): Promise<string | null> => {
    const email = emailInput.trim().toLowerCase();
    if (!email) return "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showError("Please enter a valid email address");
      return null;
    }
    if (email === user?.email?.toLowerCase()) {
      showError("You're already a member of the group");
      return null;
    }
    if (memberEmails.includes(email)) {
      showError("This email is already added");
      return null;
    }
    try {
      const exists = await checkEmail.mutateAsync(email);
      if (!exists) {
        showError(`No ${APP_NAME} account found for ${email}`);
        return null;
      }
    } catch {
      showError("Couldn't verify this email. Please try again.");
      return null;
    }
    return email;
  };

  const addEmail = async () => {
    const email = await validatePendingEmail();
    if (!email) return;
    setMemberEmails([...memberEmails, email]);
    setEmailInput("");
  };

  const removeEmail = (email: string) => {
    setMemberEmails(memberEmails.filter((e) => e !== email));
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      showError("Please enter a group name");
      return;
    }

    const pendingEmail = await validatePendingEmail();
    if (pendingEmail === null) return;

    const finalEmails = pendingEmail
      ? [...memberEmails, pendingEmail]
      : memberEmails;
    if (pendingEmail) {
      setMemberEmails(finalEmails);
      setEmailInput("");
    }

    try {
      await createGroup.mutateAsync({
        name: name.trim(),
        memberEmails: finalEmails,
        currency,
      });
      router.back();
    } catch (error) {
      showError(
        getErrorMessage(error, "Couldn't create the group. Please try again.")
      );
    }
  };

  return (
    <FormScreen>
      <TextInput
        mode="outlined"
        label="Group Name"
        placeholder="e.g., Trip to Japan"
        value={name}
        onChangeText={setName}
        autoFocus
      />

      <View style={{ marginTop: 16 }}>
        <CurrencyPicker
          label="Base currency"
          value={currency}
          onChange={setSelectedCurrency}
        />
        <Text
          variant="bodySmall"
          style={{ color: theme.colors.onSurfaceVariant, marginTop: 6 }}
        >
          Balances in this group are tracked in {currency}.
        </Text>
      </View>

      <MemberEmailInput
        value={emailInput}
        onChangeText={setEmailInput}
        onAdd={addEmail}
        onRemove={removeEmail}
        emails={memberEmails}
        isPending={checkEmail.isPending}
      />

      <Button
        mode="contained"
        onPress={handleCreate}
        loading={createGroup.isPending}
        disabled={createGroup.isPending}
        contentStyle={{ paddingVertical: 6 }}
        style={{ marginTop: 32 }}
      >
        Create Group
      </Button>
    </FormScreen>
  );
}
