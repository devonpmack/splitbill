import { useLocalSearchParams } from "expo-router";
import { useContacts, useContactCurrency } from "@/lib/queries/useContacts";
import {
  useContactExpenses,
  useCreateContactExpense,
  useUpdateContactExpense,
} from "@/lib/queries/useContactExpenses";
import { useCreateRecurringSchedule } from "@/lib/queries/useRecurringSchedules";
import { useAuth } from "@/lib/auth";
import { EmptyState } from "@/components/EmptyState";
import { ExpenseFormScreen } from "@/components/ExpenseFormScreen";
import type { MemberWithProfile } from "@/lib/types";

export function ContactAddExpenseScreen() {
  const { contactUserId, expenseId } = useLocalSearchParams<{
    contactUserId: string;
    expenseId?: string;
  }>();
  const isEdit = !!expenseId;
  const { user } = useAuth();
  const { data: contacts } = useContacts();
  const { data: contactExpenses } = useContactExpenses(contactUserId);
  const { data: pairCurrency } = useContactCurrency(contactUserId);
  const createContactExpense = useCreateContactExpense();
  const updateContactExpense = useUpdateContactExpense();
  const createSchedule = useCreateRecurringSchedule();

  const contact = contacts?.find((c) => c.contact_user_id === contactUserId);
  const contactName = contact?.full_name ?? "Contact";
  const existingExpense = isEdit
    ? contactExpenses?.find((e) => e.id === expenseId)
    : undefined;

  // A one-on-one expense is always split between exactly these two people.
  const members: MemberWithProfile[] = [
    { user_id: user?.id ?? "", profiles: { full_name: "You" } },
    { user_id: contactUserId ?? "", profiles: { full_name: contactName } },
  ];

  const memberName = (member: MemberWithProfile) =>
    member.user_id === user?.id
      ? "You"
      : (member.profiles?.full_name ?? contactName);

  // The server refuses a new expense with someone who deleted their account, so
  // say so up front instead of after the form is filled in. An existing expense
  // with them can still be edited.
  if (contact?.deleted_at && !isEdit) {
    return (
      <EmptyState
        icon="account-off"
        title="You can't add new expenses with someone who deleted their account"
        subtitle={`${contactName}'s balance and past expenses stay. You can still settle up.`}
      />
    );
  }

  return (
    <ExpenseFormScreen
      members={members}
      memberName={memberName}
      baseCurrency={pairCurrency ?? "USD"}
      existingExpense={existingExpense}
      isEdit={isEdit}
      noMembersError="Please select at least one person"
      isPending={
        isEdit
          ? updateContactExpense.isPending
          : createContactExpense.isPending || createSchedule.isPending
      }
      onSubmit={({ repeat, ...submission }) => {
        if (isEdit && expenseId) {
          return updateContactExpense.mutateAsync({
            expenseId,
            contactUserId,
            ...submission,
          });
        }
        return repeat
          ? createSchedule.mutateAsync({
              scope: { kind: "contact", contactUserId },
              ...submission,
              ...repeat,
            })
          : createContactExpense.mutateAsync({ contactUserId, ...submission });
      }}
    />
  );
}
