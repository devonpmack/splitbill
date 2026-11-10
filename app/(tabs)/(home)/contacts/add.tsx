import { useState } from "react";
import { router } from "expo-router";
import { Button, Text, TextInput } from "react-native-paper";
import {
  useSendContactRequest,
} from "@/lib/queries/useContactRequests";
import { useSnackbar } from "@/lib/snackbar";
import { useAppTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { getErrorMessage } from "@/lib/utils";
import { FormScreen } from "@/components/FormScreen";

export default function AddContact() {
  const theme = useAppTheme();
  const { user } = useAuth();
  const [email, setEmail] = useState("");
  const sendRequest = useSendContactRequest();
  const { showError, showSuccess } = useSnackbar();

  const handleSend = async () => {
    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      showError("Please enter an email address");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      showError("Please enter a valid email address");
      return;
    }
    if (normalized === user?.email?.toLowerCase()) {
      showError("You can't add yourself as a contact");
      return;
    }

    try {
      await sendRequest.mutateAsync(normalized);
      showSuccess("Request sent");
      router.back();
    } catch (error) {
      showError(
        getErrorMessage(error, "Couldn't send the request. Please try again.")
      );
    }
  };

  return (
    <FormScreen>
      <Text
        variant="bodyMedium"
        style={{ color: theme.colors.onSurfaceVariant, marginBottom: 16 }}
      >
        Send a contact request to an existing Splitfox user by their email.
        They'll need to accept before you can split one-on-one expenses.
      </Text>

        <TextInput
          mode="outlined"
          label="Email"
          placeholder="friend@example.com"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          onSubmitEditing={handleSend}
          returnKeyType="done"
          autoFocus
        />

      <Button
        mode="contained"
        onPress={handleSend}
        loading={sendRequest.isPending}
        disabled={sendRequest.isPending}
        contentStyle={{ paddingVertical: 6 }}
        style={{ marginTop: 32 }}
      >
        Send Request
      </Button>
    </FormScreen>
  );
}
