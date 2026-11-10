import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { PaperProvider } from "react-native-paper";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryBuilder } from "../helpers/testUtils";
import { lightTheme } from "@/lib/theme";
import { ConfirmProvider } from "@/lib/confirm";
import Repeating from "@/app/repeating";
import { supabase } from "@/lib/supabase";

// The real hooks and confirm dialog, with only the Supabase client mocked:
// pressing Stop and confirming must call the RPC and refresh what it changed.
jest.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ groupId: "g1" }),
}));
jest.mock("@/lib/supabase", () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));
jest.mock("@/lib/auth", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));
jest.mock("@/lib/queries/useGroups", () => ({
  useGroup: () => ({ data: { id: "g1", group_members: [] } }),
}));
jest.mock("@/lib/queries/useContacts", () => ({
  useContacts: () => ({ data: [] }),
}));
const mockShowSuccess = jest.fn();
jest.mock("@/lib/snackbar", () => ({
  useSnackbar: () => ({ showError: jest.fn(), showSuccess: mockShowSuccess }),
}));

const mockedSupabase = supabase as unknown as {
  from: jest.Mock;
  rpc: jest.Mock;
};

const rent = {
  id: "s1",
  kind: "group",
  group_id: "g1",
  paid_by: "u1",
  description: "Rent",
  amount: 1200,
  currency: "USD",
  frequency: "monthly",
  start_date: "2026-01-31",
  end_date: null,
  max_count: null,
  next_index: 1,
  stopped_at: null,
  stop_reason: null,
  failed_runs: 0,
  created_at: "2026-01-31T00:00:00Z",
};

it("stops the schedule through the RPC and refreshes the schedules, expenses and balances", async () => {
  const stoppedRent = {
    ...rent,
    stopped_at: "2026-03-01T00:00:00Z",
    stop_reason: "stopped",
  };
  mockedSupabase.from
    .mockReturnValueOnce(queryBuilder({ data: [rent], error: null }))
    .mockReturnValue(queryBuilder({ data: [stoppedRent], error: null }));
  mockedSupabase.rpc.mockResolvedValue({ data: stoppedRent, error: null });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
  const invalidate = jest.spyOn(queryClient, "invalidateQueries");

  await render(
    <PaperProvider theme={lightTheme}>
      <QueryClientProvider client={queryClient}>
        <ConfirmProvider>
          <Repeating />
        </ConfirmProvider>
      </QueryClientProvider>
    </PaperProvider>
  );

  await fireEvent.press(await screen.findByText("Stop"));
  expect(mockedSupabase.rpc).not.toHaveBeenCalled();

  // The dialog's confirm button is a second "Stop", after the card's.
  await waitFor(() => expect(screen.getAllByText("Stop")).toHaveLength(2));
  await fireEvent.press(screen.getAllByText("Stop")[1]);

  await waitFor(() =>
    expect(mockedSupabase.rpc).toHaveBeenCalledWith("stop_recurring_schedule", {
      p_schedule_id: "s1",
    })
  );
  await waitFor(() =>
    expect(screen.getByText("Nothing repeats yet")).toBeTruthy()
  );
  expect(screen.getByText("Stopped (1)")).toBeTruthy();
  expect(mockShowSuccess).toHaveBeenCalledWith("Stopped repeating");

  const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  for (const key of [
    ["recurring-schedules"],
    ["expenses", "g1"],
    ["balances", "g1"],
    ["total-balance"],
  ]) {
    expect(keys).toContain(JSON.stringify(key));
  }
});
