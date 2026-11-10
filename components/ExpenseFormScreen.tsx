import { useState } from "react";
import { router, Stack } from "expo-router";
import { Button, TextInput } from "react-native-paper";
import { useAuth } from "@/lib/auth";
import { useDayPick } from "@/lib/useDayPick";
import { useHydrateOnce } from "@/lib/useHydrateOnce";
import {
  computeSplits,
  getErrorMessage,
  roundToCurrency,
} from "@/lib/utils";
import { resolveEntryRate } from "@/lib/currency";
import {
  buildRepeat,
  lastOccurrenceDate,
  occurrenceDate,
  parseRepeatCount,
  type RepeatEnds,
  type RepeatSubmission,
} from "@/lib/recurrence";
import {
  deviceTimeZone,
  formatCalendarDay,
  isMovedOccurrence,
  parseCalendarDate,
  startOfLocalDayISO,
  toLocalDateString,
} from "@/lib/dates";
import { useExchangeRates } from "@/lib/exchange-rates";
import { useScheduleFrequencies } from "@/lib/queries/useRecurringSchedules";
import { useSnackbar } from "@/lib/snackbar";
import { DateField } from "@/components/DateField";
import { FormScreen } from "@/components/FormScreen";
import { RepeatFields } from "@/components/RepeatFields";
import { ExpenseAmountCurrencyInput } from "@/components/groups/ExpenseAmountCurrencyInput";
import { PaidByPicker } from "@/components/groups/PaidByPicker";
import { SplitMembersSection } from "@/components/groups/SplitMembersSection";
import { SplitTypeSelector } from "@/components/groups/SplitTypeSelector";
import type {
  MemberWithProfile,
  RecurringFrequency,
  SplitType,
} from "@/lib/types";

// The expense being edited, as far as this form needs it.
export type EditableExpense = {
  description: string;
  amount: number;
  paid_by: string;
  split_type: SplitType;
  currency: string;
  exchange_rate: number;
  date?: string;
  schedule_id?: string | null;
  occurrence_date?: string | null;
  hand_edited?: boolean;
  expense_splits?: { user_id: string; amount: number }[] | null;
};

export type ExpenseFormSubmission = {
  paidBy: string;
  amount: number;
  description: string;
  splitType: SplitType;
  splits: { userId: string; amount: number }[];
  currency: string;
  exchangeRate: number;
  date?: string;
  // Present when a new expense repeats; `date` is then absent, the start day
  // is in here.
  repeat?: RepeatSubmission;
};

// A scheduled row is dated by its schedule's calendar day, whichever zone it is
// edited from, unless a member moved it.
function storedDate(
  expense: EditableExpense | undefined,
  scheduleTz: string | undefined
): string | undefined {
  if (
    !expense?.occurrence_date ||
    isMovedOccurrence(
      expense.date ?? "",
      expense.occurrence_date,
      expense.hand_edited,
      scheduleTz
    )
  ) {
    return expense?.date;
  }
  return startOfLocalDayISO(parseCalendarDate(expense.occurrence_date));
}

type ExpenseFormScreenProps = {
  members: MemberWithProfile[];
  memberName: (member: MemberWithProfile) => string;
  // The currency balances are kept in (a group's currency, or a pair's).
  baseCurrency: string;
  baseCurrencyLabel?: string;
  // Present when editing; absent when creating.
  existingExpense?: EditableExpense;
  isEdit: boolean;
  noMembersError: string;
  isPending: boolean;
  onSubmit: (submission: ExpenseFormSubmission) => Promise<unknown>;
};

export function ExpenseFormScreen({
  members,
  memberName,
  baseCurrency,
  baseCurrencyLabel,
  existingExpense,
  isEdit,
  noMembersError,
  isPending,
  onSubmit,
}: ExpenseFormScreenProps) {
  const { user } = useAuth();
  const { data: rates } = useExchangeRates();
  const { showError } = useSnackbar();

  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [paidBy, setPaidBy] = useState(user?.id ?? "");
  const [splitType, setSplitType] = useState<SplitType>("equal");
  const [customSplits, setCustomSplits] = useState<Record<string, string>>({});
  const [excludedMemberIds, setExcludedMemberIds] = useState<string[]>([]);
  const [currency, setCurrency] = useState<string | null>(null);

  const [frequency, setFrequency] = useState<RecurringFrequency | null>(null);
  const [ends, setEnds] = useState<RepeatEnds>("never");
  const [pickedEndDay, setPickedEndDay] = useState<Date | null | undefined>(
    undefined
  );
  const [repeatCount, setRepeatCount] = useState("12");

  const { data: schedules } = useScheduleFrequencies();
  const scheduleTz = existingExpense?.schedule_id
    ? schedules?.[existingExpense.schedule_id]?.tz
    : undefined;
  const day = useDayPick(
    isEdit ? storedDate(existingExpense, scheduleTz) : undefined
  );
  const repeating = !isEdit && frequency !== null;
  const startDay = day.value ?? new Date();
  const startDate = toLocalDateString(startDay);
  // Until the user picks an end day, the end is one step after the start.
  const endDay =
    pickedEndDay === undefined
      ? parseCalendarDate(occurrenceDate(startDate, frequency ?? "daily", 1))
      : pickedEndDay;
  const repeatCountValue = parseRepeatCount(repeatCount);
  const lastOccurrence =
    frequency && ends === "count" && repeatCountValue
      ? lastOccurrenceDate(startDate, frequency, repeatCountValue)
      : null;
  const entryCurrency = currency ?? baseCurrency;

  useHydrateOnce(isEdit && !!existingExpense && members.length > 0, () => {
    if (!existingExpense) return;

    setDescription(existingExpense.description);
    setAmount(String(existingExpense.amount));
    setPaidBy(existingExpense.paid_by);
    setSplitType(existingExpense.split_type);
    setCurrency(existingExpense.currency);

    const splits = existingExpense.expense_splits ?? [];
    const splitUserIds = splits.map((s) => s.user_id);
    setExcludedMemberIds(
      members.map((m) => m.user_id).filter((id) => !splitUserIds.includes(id))
    );

    const total = existingExpense.amount;
    const custom: Record<string, string> = {};
    if (existingExpense.split_type === "exact") {
      for (const s of splits) custom[s.user_id] = s.amount.toFixed(2);
    } else if (existingExpense.split_type === "percentage") {
      for (const s of splits) {
        custom[s.user_id] =
          total > 0 ? ((s.amount / total) * 100).toFixed(2) : "";
      }
    }
    setCustomSplits(custom);
  });

  const selectedMembers = members
    .map((member) => member.user_id)
    .filter((userId) => !excludedMemberIds.includes(userId));
  const effectivePaidBy = paidBy || user?.id || "";
  // Round to the entry currency's precision up front: a JPY amount of 1000.5
  // cannot be split into whole yen, and the server compares the split total to
  // round(p_amount, 2).
  const totalAmount = roundToCurrency(parseFloat(amount) || 0, entryCurrency);
  const isForeignCurrency = entryCurrency !== baseCurrency;
  const { rate: exchangeRate, hasRate: hasExchangeRate } = resolveEntryRate(
    entryCurrency,
    baseCurrency,
    rates,
    isEdit ? existingExpense : undefined
  );
  const convertedBase = Math.round(totalAmount * exchangeRate * 100) / 100;

  const toggleMember = (userId: string) => {
    setExcludedMemberIds((prev) =>
      prev.includes(userId)
        ? prev.filter((id) => id !== userId)
        : [...prev, userId]
    );
  };

  const handleSubmit = async () => {
    if (!description.trim()) {
      showError("Please enter a description");
      return;
    }
    if (!totalAmount || totalAmount <= 0) {
      showError("Please enter a valid amount");
      return;
    }
    if (selectedMembers.length === 0) {
      showError(noMembersError);
      return;
    }
    if (!effectivePaidBy) {
      showError("Please select who paid");
      return;
    }
    if (day.isInvalid) {
      showError("Please enter a valid date");
      return;
    }
    if (isForeignCurrency && !hasExchangeRate) {
      showError(
        "Exchange rates aren't available for this currency pair. Try again when rates are cached."
      );
      return;
    }

    const result = computeSplits(
      splitType,
      totalAmount,
      selectedMembers,
      customSplits,
      entryCurrency
    );
    if (!result.ok) {
      showError(result.error);
      return;
    }

    const repeat =
      repeating && frequency
        ? buildRepeat({
            frequency,
            startDay,
            ends,
            endDay,
            count: repeatCount,
            timeZone: deviceTimeZone(),
          })
        : undefined;
    if (repeat && !repeat.ok) {
      showError(repeat.error);
      return;
    }

    try {
      await onSubmit({
        paidBy: effectivePaidBy,
        amount: totalAmount,
        description: description.trim(),
        splitType,
        splits: result.splits,
        currency: entryCurrency,
        exchangeRate,
        ...(repeat?.ok
          ? { repeat: repeat.repeat }
          : { date: day.dateParam }),
      });
      router.back();
    } catch (error) {
      showError(
        getErrorMessage(
          error,
          isEdit
            ? "Couldn't save the expense. Please try again."
            : "Couldn't add the expense. Please try again."
        )
      );
    }
  };

  return (
    <FormScreen
      header={
        <Stack.Screen
          options={{ title: isEdit ? "Edit Expense" : "Add Expense" }}
        />
      }
    >
      <TextInput
        mode="outlined"
        label="Description"
        placeholder="What was this expense for?"
        value={description}
        onChangeText={setDescription}
        autoFocus
      />

      <ExpenseAmountCurrencyInput
        amount={amount}
        onAmountChange={setAmount}
        entryCurrency={entryCurrency}
        onCurrencyChange={setCurrency}
        baseCurrency={baseCurrency}
        totalAmount={totalAmount}
        convertedBase={convertedBase}
        isForeignCurrency={isForeignCurrency}
        hasExchangeRate={hasExchangeRate}
        baseCurrencyLabel={baseCurrencyLabel}
      />

      <DateField
        value={day.value}
        onChange={day.onChange}
        label={repeating ? "Starts" : "Date"}
      />

      {isEdit ? null : (
        <RepeatFields
          frequency={frequency}
          onFrequencyChange={setFrequency}
          ends={ends}
          onEndsChange={setEnds}
          endDay={endDay}
          onEndDayChange={setPickedEndDay}
          count={repeatCount}
          onCountChange={setRepeatCount}
          isForeignCurrency={entryCurrency !== baseCurrency}
          countIsValid={repeatCountValue !== null}
          lastOccurrenceLabel={
            lastOccurrence
              ? `The last one is on ${formatCalendarDay(lastOccurrence)}.`
              : undefined
          }
        />
      )}

      <PaidByPicker
        members={members}
        paidBy={effectivePaidBy}
        onSelect={setPaidBy}
        getMemberName={memberName}
      />

      <SplitTypeSelector value={splitType} onChange={setSplitType} />

      <SplitMembersSection
        members={members}
        selectedMemberIds={selectedMembers}
        splitType={splitType}
        totalAmount={totalAmount}
        customSplits={customSplits}
        currencyCode={entryCurrency}
        getMemberName={memberName}
        onToggleMember={toggleMember}
        onChangeCustom={(userId, val) =>
          setCustomSplits((prev) => ({ ...prev, [userId]: val }))
        }
      />

      <Button
        mode="contained"
        onPress={handleSubmit}
        loading={isPending}
        disabled={isPending}
        contentStyle={{ paddingVertical: 6 }}
        style={{ marginTop: 32, marginBottom: 32 }}
      >
        {isEdit ? "Save Changes" : "Add Expense"}
      </Button>
    </FormScreen>
  );
}
