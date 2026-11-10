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
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-11-09T12:00:00.000Z") });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  async function backgroundFor(ms: number, handler = () => appStateHandler) {
    handler()?.("background");
    jest.setSystemTime(Date.now() + ms);
    handler()?.("active");
  }

  it("invalidates every query when the app returns after a long time in the background", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    await backgroundFor(30_000);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("does nothing after a short time in the background", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    await backgroundFor(29_999);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does nothing for an inactive blip, however long it lasts (notification pulldown)", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    appStateHandler?.("inactive");
    jest.setSystemTime(Date.now() + 5 * 60_000);
    appStateHandler?.("active");

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("counts inactive time before the background toward nothing: the clock starts at background", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    appStateHandler?.("inactive");
    jest.setSystemTime(Date.now() + 60_000);
    appStateHandler?.("background");
    jest.setSystemTime(Date.now() + 1_000);
    appStateHandler?.("active");

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("does not invalidate again for a second activation without a new background", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    await backgroundFor(60_000);
    jest.setSystemTime(Date.now() + 60_000);
    appStateHandler?.("active");

    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the app stays active", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useRefetchOnForeground(), { wrapper: Wrapper });

    appStateHandler?.("active");

    expect(invalidate).not.toHaveBeenCalled();
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
