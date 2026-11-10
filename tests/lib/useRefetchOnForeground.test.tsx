import React from "react";
import { AppState } from "react-native";
import { renderHook } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRefetchOnForeground } from "@/lib/useRefetchOnForeground";

let appStateHandler: ((state: string) => void) | undefined;
const mockRemove = jest.fn();

function makeWrapper() {
  const queryClient = new QueryClient();
  const invalidate = jest
    .spyOn(queryClient, "invalidateQueries")
    .mockImplementation(() => Promise.resolve());
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { Wrapper, invalidate };
}

beforeEach(() => {
  appStateHandler = undefined;
  mockRemove.mockClear();
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation(((_type: string, handler: (state: string) => void) => {
      appStateHandler = handler;
      return { remove: mockRemove };
    }) as never);
  (AppState as { currentState: string }).currentState = "active";
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("useRefetchOnForeground", () => {
  it("invalidates every query when the app returns to the foreground", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    appStateHandler?.("background");
    expect(invalidate).not.toHaveBeenCalled();

    appStateHandler?.("active");
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("does not invalidate again while the app stays active", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    appStateHandler?.("active");

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("treats inactive to active as a return to the foreground", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    appStateHandler?.("inactive");
    appStateHandler?.("active");

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("stops listening on unmount", async () => {
    const { Wrapper } = makeWrapper();
    const { unmount } = await renderHook(() => useRefetchOnForeground(), {
      wrapper: Wrapper,
    });

    await unmount();

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
