import { useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Button, Text } from "react-native-paper";
import { useGroup } from "@/lib/queries/useGroups";
import {
  useAddGroupMembers,
  useCheckGroupMemberEmail,
} from "@/lib/queries/useGroups";
import { useSnackbar } from "@/lib/snackbar";
import { useAppTheme } from "@/lib/theme";
import { useAuth } from "@/lib/auth";
import { getErrorMessage } from "@/lib/utils";
import { FormScreen } from "@/components/FormScreen";
import { MemberEmailInput } from "@/components/groups/MemberEmailInput";

export default function AddGroupMembers() {
  const theme = useAppTheme();
  const { user } = useAuth();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const { data: group } = useGroup(groupId!);

  const [emailInput, setEmailInput] = useState("");
  const [memberEmails, setMemberEmails] = useState<string[]>([]);

  const addMembers = useAddGroupMembers();
  const checkGroupMemberEmail = useCheckGroupMemberEmail();
  const { showError, showSuccess } = useSnackbar();

  const memberCount = group?.group_members?.length ?? 0;

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
      // Membership is checked server-side: the lookup no longer returns a user
      // id to compare against the loaded member list.
      const status = await checkGroupMemberEmail.mutateAsync({
        groupId: groupId!,
        email,
      });
      if (status === "not_registered") {
        showError(`No Splitfox account found for ${email}`);
        return null;
      }
      if (status === "already_member") {
        showError("This person is already a member of the group");
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

  const handleAddMembers = async () => {
    const pendingEmail = await validatePendingEmail();
    if (pendingEmail === null) return;

    const finalEmails = pendingEmail
      ? [...memberEmails, pendingEmail]
      : memberEmails;

    if (finalEmails.length === 0) {
      showError("Add at least one email to invite");
      return;
    }

    try {
      await addMembers.mutateAsync({
        groupId: groupId!,
        memberEmails: finalEmails,
      });
      showSuccess(finalEmails.length > 1 ? "Members added" : "Member added");
      router.back();
    } catch (error) {
      showError(
        getErrorMessage(error, "Couldn't add members. Please try again.")
      );
    }
  };

  return (
    <FormScreen>
      <Text
        variant="titleMedium"
        style={{ fontWeight: "bold", marginBottom: 4 }}
      >
        Add members
      </Text>
      <Text
        variant="bodySmall"
        style={{ color: theme.colors.onSurfaceVariant }}
      >
        {memberCount} member{memberCount === 1 ? "" : "s"} in this group
      </Text>

        <MemberEmailInput
          value={emailInput}
          onChangeText={setEmailInput}
          onAdd={addEmail}
          onRemove={removeEmail}
          emails={memberEmails}
          isPending={checkGroupMemberEmail.isPending}
        />

      <Button
        mode="contained"
        onPress={handleAddMembers}
        loading={addMembers.isPending}
        disabled={addMembers.isPending}
        contentStyle={{ paddingVertical: 6 }}
        style={{ marginTop: 32 }}
      >
        Add Members
      </Button>
    </FormScreen>
  );
}
