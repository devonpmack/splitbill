import type { QueryClient } from "@tanstack/react-query";

// Shared cache-invalidation sets.
//
// Every write moves more than the rows it touched: balances are derived from
// expenses and payments, the simplified edges are derived from balances, and the
// activity feed and contact views are assembled from all of them. Spelling those
// key sets out at each mutation is how keys came to be missing from some of them
// (the activity feed never refreshed on a realtime group write), so each set
// lives here once.

// Contact list, combined balances and the per-group breakdown all read from
// group-level rows as well as one-on-one rows.
export function invalidateContactQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["contacts"] });
  queryClient.invalidateQueries({ queryKey: ["contact-balance"] });
  queryClient.invalidateQueries({ queryKey: ["contact-group-breakdown"] });
}

// The global Activity feed is assembled from five independent queries.
export function invalidateActivityQueries(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["activity"] });
  queryClient.invalidateQueries({ queryKey: ["activity-payments"] });
  queryClient.invalidateQueries({ queryKey: ["contact-activity"] });
  queryClient.invalidateQueries({ queryKey: ["contact-payments-activity"] });
  queryClient.invalidateQueries({ queryKey: ["simplify-debts-activity"] });
}

// Everything derived from one group's expenses and payments.
export function invalidateGroupQueries(
  queryClient: QueryClient,
  groupId: string
) {
  queryClient.invalidateQueries({ queryKey: ["expenses", groupId] });
  queryClient.invalidateQueries({ queryKey: ["payments", groupId] });
  queryClient.invalidateQueries({ queryKey: ["balances", groupId] });
  queryClient.invalidateQueries({ queryKey: ["group-pairwise-all", groupId] });
  queryClient.invalidateQueries({ queryKey: ["group-simplified", groupId] });
  queryClient.invalidateQueries({ queryKey: ["total-balance"] });
  invalidateContactQueries(queryClient);
  invalidateActivityQueries(queryClient);
}

// Everything derived from one contact pair's expenses and payments.
export function invalidateContactPairQueries(
  queryClient: QueryClient,
  userId: string | undefined,
  contactUserId: string
) {
  queryClient.invalidateQueries({
    queryKey: ["contact-expenses", userId, contactUserId],
  });
  queryClient.invalidateQueries({
    queryKey: ["contact-payments", userId, contactUserId],
  });
  queryClient.invalidateQueries({
    queryKey: ["contact-balance", userId, contactUserId],
  });
  queryClient.invalidateQueries({
    queryKey: ["contact-pair-balance", userId, contactUserId],
  });
  queryClient.invalidateQueries({ queryKey: ["total-balance"] });
  invalidateContactQueries(queryClient);
  invalidateActivityQueries(queryClient);
}

// Rows the server created on its own (a due repeat of a recurring expense) are
// not tied to one group or contact pair, so every list and balance that reads
// expenses is refetched.
export function invalidateRecurringCreated(queryClient: QueryClient) {
  queryClient.invalidateQueries({ queryKey: ["expenses"] });
  queryClient.invalidateQueries({ queryKey: ["contact-expenses"] });
  queryClient.invalidateQueries({ queryKey: ["balances"] });
  queryClient.invalidateQueries({ queryKey: ["group-pairwise-all"] });
  queryClient.invalidateQueries({ queryKey: ["group-simplified"] });
  queryClient.invalidateQueries({ queryKey: ["contact-pair-balance"] });
  queryClient.invalidateQueries({ queryKey: ["total-balance"] });
  queryClient.invalidateQueries({ queryKey: ["recurring-schedules"] });
  invalidateContactQueries(queryClient);
  invalidateActivityQueries(queryClient);
}
