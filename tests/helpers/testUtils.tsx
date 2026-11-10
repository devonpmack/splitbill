import React, { ReactElement, ReactNode } from "react";
import { act, fireEvent, render } from "@testing-library/react-native";
import { PaperProvider } from "react-native-paper";
import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
} from "@tanstack/react-query";
import { lightTheme } from "@/lib/theme";
import { DisplayCurrencyProvider } from "@/lib/display-currency";

// Flush React Query notifications synchronously so observer state updates
// happen inside the awaited render/act scope, avoiding act(...) warnings.
notifyManager.setScheduler((cb) => cb());

/**
 * Runs an async mutation inside React's act() so the resulting observer state
 * updates (isPending -> isSuccess/isError) don't trigger act(...) warnings.
 */
export async function actAsync<T>(fn: () => Promise<T>): Promise<T> {
  let value: T;
  await act(async () => {
    value = await fn();
  });
  return value!;
}

/**
 * Pins `new Date()` / `Date.now()` to `now` while leaving every timer real, so
 * promises, waitFor and React Query behave as usual. Pair with
 * `jest.useRealTimers()` in afterEach.
 */
export function freezeNow(now: Date) {
  jest.useFakeTimers({
    now,
    doNotFake: [
      "nextTick",
      "setImmediate",
      "clearImmediate",
      "setInterval",
      "clearInterval",
      "setTimeout",
      "clearTimeout",
      "queueMicrotask",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "hrtime",
      "performance",
    ],
  });
}

/**
 * Types into a DateField the way a device does: the native `change` event
 * (carrying the raw text) fires before `changeText`.
 */
export async function typeDate(
  input: Parameters<typeof fireEvent.changeText>[0],
  text: string
) {
  await fireEvent(input, "change", { nativeEvent: { text } });
  await fireEvent.changeText(input, text);
}

/**
 * Wraps a tree in the app's cross-cutting providers. Tests use the real
 * providers rather than mocks so provider-ordering mistakes surface here (see
 * testing.md Rule 6).
 */
function AppProviders({ children }: { children: ReactNode }) {
  return (
    <PaperProvider theme={lightTheme}>
      <DisplayCurrencyProvider>{children}</DisplayCurrencyProvider>
    </PaperProvider>
  );
}

/**
 * Renders a screen wrapped in the app's providers so react-native-paper
 * components, useAppTheme and useDisplayCurrency resolve correctly. render() is
 * async in RNTL v14, so callers must await this.
 */
export async function renderWithPaper(ui: ReactElement) {
  const view = await render(<AppProviders>{ui}</AppProviders>);
  return {
    ...view,
    // Re-wrap on rerender; the bare RNTL rerender would drop the providers.
    rerender: (next: ReactElement) =>
      view.rerender(<AppProviders>{next}</AppProviders>),
  };
}

/**
 * Builds a React Query provider wrapper for renderHook. Retries are disabled so
 * rejected queries/mutations surface immediately instead of being retried.
 */
export function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      // gcTime: 0 on both queries and mutations so cache entries are garbage
      // collected immediately when their observers unmount. Without it the
      // MutationCache keeps a 5-minute GC timer alive, which leaves the Jest
      // worker hanging (and force-exited) after the tests finish.
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <DisplayCurrencyProvider>{children}</DisplayCurrencyProvider>
      </QueryClientProvider>
    );
  };
}

export interface SupabaseResult<T = unknown> {
  data: T;
  error: unknown;
}

type ChainMethod =
  | "select"
  | "eq"
  | "in"
  | "lte"
  | "gt"
  | "order"
  | "limit"
  | "single"
  | "insert"
  | "update"
  | "delete";

const CHAIN_METHODS: ChainMethod[] = [
  "select",
  "eq",
  "in",
  "lte",
  "gt",
  "order",
  "limit",
  "single",
  "insert",
  "update",
  "delete",
];

export type QueryBuilderMock = Record<ChainMethod, jest.Mock> &
  PromiseLike<SupabaseResult>;

/**
 * Creates a chainable Supabase query-builder mock. Every chain method returns
 * the same builder, and the builder is thenable so `await builder.select()...`
 * resolves to the provided result.
 */
export function queryBuilder<T = unknown>(
  result: SupabaseResult<T>
): QueryBuilderMock {
  const builder = {} as QueryBuilderMock;
  for (const method of CHAIN_METHODS) {
    builder[method] = jest.fn(() => builder);
  }
  (builder as { then: PromiseLike<SupabaseResult>["then"] }).then = (
    onFulfilled,
    onRejected
  ) => Promise.resolve(result as SupabaseResult).then(onFulfilled, onRejected);
  return builder;
}
