import {
  DEFAULT_CURRENCY,
  getCurrencyDecimals,
  getCurrencySymbol,
  type CurrencyCode,
} from "./currency";
import { partitionUpcoming } from "./upcoming";
import type {
  ActivityContactExpense,
  ActivityContactPayment,
  ActivityExpense,
  ActivityFeedItem,
  ActivityPayment,
  ActivitySimplifyDebtsEvent,
  BalanceBreakdown,
  DebtEdge,
  MemberWithProfile,
  SplitType,
} from "./types";

function roundToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function formatCurrency(
  amount: number,
  currencyCode: CurrencyCode = DEFAULT_CURRENCY
): string {
  const decimals = getCurrencyDecimals(currencyCode);
  const symbol = getCurrencySymbol(currencyCode);
  const formatted = Math.abs(amount).toFixed(decimals);
  return amount < 0 ? `-${symbol}${formatted}` : `${symbol}${formatted}`;
}

// Converts each split into a base-currency amount using `rate` and assigns any
// rounding remainder to the largest split so the base amounts sum exactly to
// `baseTotal`. The largest split is used because a negative remainder must not
// push a share below zero -- `expense_splits.base_amount` is constrained to
// be non-negative, and a zero share must stay zero.
export function convertSplitsToBase<T extends { amount: number }>(
  splits: T[],
  rate: number,
  baseTotal: number
): (T & { baseAmount: number })[] {
  const result = splits.map((split) => ({
    ...split,
    baseAmount: Math.round(split.amount * rate * 100) / 100,
  }));
  const sum = result.reduce((acc, s) => acc + s.baseAmount, 0);
  const remainder = Math.round((baseTotal - sum) * 100) / 100;
  if (remainder === 0 || result.length === 0) return result;

  let target = 0;
  for (let i = 1; i < result.length; i++) {
    if (result[i].baseAmount > result[target].baseAmount) target = i;
  }
  result[target].baseAmount =
    Math.round((result[target].baseAmount + remainder) * 100) / 100;
  return result;
}

export function roundToCurrency(
  amount: number,
  currencyCode: CurrencyCode = DEFAULT_CURRENCY
): number {
  return roundToDecimals(amount, getCurrencyDecimals(currencyCode));
}

// Builds the RPC split payload, converting each split into the group/pair base
// currency at the given rate so the server can store base_amount per split.
export function buildSplitsPayload(
  splits: { userId: string; amount: number }[],
  amount: number,
  rate: number
): { userId: string; amount: number; baseAmount: number }[] {
  const baseTotal = Math.round(amount * rate * 100) / 100;
  return convertSplitsToBase(splits, rate, baseTotal).map((s) => ({
    userId: s.userId,
    amount: s.amount,
    baseAmount: s.baseAmount,
  }));
}

export function splitEqual(
  total: number,
  memberCount: number,
  decimals = 2
): number[] {
  const factor = 10 ** decimals;
  const perPerson = Math.floor((total * factor) / memberCount) / factor;
  const remainder = roundToDecimals(total - perPerson * memberCount, decimals);
  const splits = new Array(memberCount).fill(perPerson);
  if (remainder > 0) {
    splits[0] = roundToDecimals(splits[0] + remainder, decimals);
  }
  return splits;
}

export function validateSplitsTotal(
  total: number,
  splits: number[],
  decimals = 2
): boolean {
  const roundedTotal = roundToDecimals(total, decimals);
  const splitTotal = splits.reduce((sum, amount) => sum + amount, 0);
  return roundToDecimals(splitTotal, decimals) === roundedTotal;
}

export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export type ComputeSplitsResult =
  | { ok: true; splits: { userId: string; amount: number }[] }
  | { ok: false; error: string };

export function computeSplits(
  splitType: SplitType,
  totalAmount: number,
  memberIds: string[],
  rawInputs: Record<string, string>,
  currencyCode: CurrencyCode = DEFAULT_CURRENCY
): ComputeSplitsResult {
  const decimals = getCurrencyDecimals(currencyCode);

  if (splitType === "equal") {
    const amounts = splitEqual(totalAmount, memberIds.length, decimals);
    return {
      ok: true,
      splits: memberIds.map((userId, i) => ({ userId, amount: amounts[i] })),
    };
  }

  if (splitType === "exact") {
    const splits = memberIds.map((userId) => ({
      userId,
      amount: roundToDecimals(parseFloat(rawInputs[userId] || "0"), decimals),
    }));
    const sum = splits.reduce((acc, s) => acc + s.amount, 0);
    // Tolerate up to half of the currency's smallest unit so rounding noise
    // doesn't reject an otherwise-balanced split.
    const epsilon = 0.5 / 10 ** decimals;
    if (Math.abs(sum - totalAmount) > epsilon) {
      return {
        ok: false,
        error: `Split amounts (${formatCurrency(sum, currencyCode)}) don't add up to total (${formatCurrency(totalAmount, currencyCode)})`,
      };
    }
    return { ok: true, splits };
  }

  const pctSum = memberIds.reduce(
    (acc, userId) => acc + parseFloat(rawInputs[userId] || "0"),
    0
  );
  if (Math.abs(pctSum - 100) > 0.01) {
    return {
      ok: false,
      error: `Percentages must add up to 100% (currently ${pctSum.toFixed(1)}%)`,
    };
  }
  // Distribute by percentage, rounding to the currency's precision and
  // assigning any rounding remainder to the last member so splits always sum
  // exactly to the total.
  const splits = memberIds.map((userId) => {
    const pct = parseFloat(rawInputs[userId] || "0");
    return { userId, amount: roundToDecimals((totalAmount * pct) / 100, decimals) };
  });
  const splitSum = splits.reduce((acc, s) => acc + s.amount, 0);
  const remainder = roundToDecimals(totalAmount - splitSum, decimals);
  if (remainder !== 0 && splits.length > 0) {
    const last = splits[splits.length - 1];
    last.amount = roundToDecimals(last.amount + remainder, decimals);
  }
  return { ok: true, splits };
}

// Newest first, for feeds assembled from several differently-shaped queries.
export function sortByTimestampDesc<T extends { ts: string }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime()
  );
}

// Every edge touching `userId`, framed from that member's point of view.
export function memberDebtBreakdown(
  debts: DebtEdge[],
  userId: string
): BalanceBreakdown[] {
  return [
    ...debts
      .filter((d) => d.from === userId)
      .map((d) => ({
        direction: "owes" as const,
        name: d.to_name,
        amount: d.amount,
      })),
    ...debts
      .filter((d) => d.to === userId)
      .map((d) => ({
        direction: "owed" as const,
        name: d.from_name,
        amount: d.amount,
      })),
  ];
}

// Net amount each other member owes `currentUserId` across the debt edges.
// Positive means they owe the current user; negative means the reverse.
export function netDebtsByCounterparty(
  debts: DebtEdge[],
  currentUserId: string | undefined
): Map<string, number> {
  const byUser = new Map<string, number>();
  for (const debt of debts) {
    if (debt.to === currentUserId) {
      byUser.set(debt.from, (byUser.get(debt.from) ?? 0) + debt.amount);
    } else if (debt.from === currentUserId) {
      byUser.set(debt.to, (byUser.get(debt.to) ?? 0) - debt.amount);
    }
  }
  return byUser;
}

// The current user first, then everyone else by display name.
export function sortMembersSelfFirst<T extends MemberWithProfile>(
  members: T[],
  currentUserId: string | undefined
): T[] {
  return [...members].sort((a, b) => {
    if (a.user_id === currentUserId) return -1;
    if (b.user_id === currentUserId) return 1;
    return (a.profiles?.full_name ?? "").localeCompare(
      b.profiles?.full_name ?? ""
    );
  });
}

// Merges the activity queries into one feed. Each source is tagged with the
// `kind` its card renders and the timestamp it sorts on. Rows dated after `now`
// come back separately as `upcoming` (soonest first); `past` is newest first.
// `get_recent_activity` leaves future expenses out, so they arrive through
// `upcomingExpenses` (get_upcoming_expenses); both expense sources are
// partitioned here so a row whose date passes since the fetch moves to `past`
// without a refetch.
export function buildActivityFeed(
  sources: {
    expenses?: ActivityExpense[];
    upcomingExpenses?: ActivityExpense[];
    payments?: ActivityPayment[];
    contactExpenses?: ActivityContactExpense[];
    contactPayments?: ActivityContactPayment[];
    simplifyEvents?: ActivitySimplifyDebtsEvent[];
  },
  now: Date = new Date()
): { upcoming: ActivityFeedItem[]; past: ActivityFeedItem[] } {
  const expenseIds = new Set<string>();
  const expenses = [
    ...(sources.expenses ?? []),
    ...(sources.upcomingExpenses ?? []),
  ].filter((expense) => {
    if (expenseIds.has(expense.id)) return false;
    expenseIds.add(expense.id);
    return true;
  });

  const items: ActivityFeedItem[] = [
    ...expenses.map((payload) => ({
      kind: "expense" as const,
      id: payload.id,
      ts: payload.date,
      payload,
    })),
    ...(sources.payments ?? []).map((payload) => ({
      kind: "payment" as const,
      id: payload.id,
      ts: payload.date,
      payload,
    })),
    ...(sources.contactExpenses ?? []).map((payload) => ({
      kind: "contact-expense" as const,
      id: payload.id,
      ts: payload.date,
      payload,
    })),
    ...(sources.contactPayments ?? []).map((payload) => ({
      kind: "contact-payment" as const,
      id: payload.id,
      ts: payload.date,
      payload,
    })),
    ...(sources.simplifyEvents ?? []).map((payload) => ({
      kind: "simplify-debts" as const,
      id: payload.id,
      ts: payload.created_at,
      payload,
    })),
  ];

  return partitionUpcoming(items, (item) => item.ts, now);
}
