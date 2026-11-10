import React from "react";
import { AppState } from "react-native";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useMaterialiseOnForeground } from "@/lib/useMaterialiseOnForeground";
import { freezeNow } from "../helpers/testUtils";

jest.mock("@/lib/supabase", () => ({ supabase: { rpc: jest.fn() } }));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));

const mockedRpc = (supabase as unknown as { rpc: jest.Mock }).rpc;
const mockedUseAuth = useAuth as unknown as jest.Mock;

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
  const keys = () =>
    invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
  return { Wrapper, invalidate, keys };
}

// The app goes to the background, `ms` pass, and it comes back.
async function awayFor(ms: number) {
  await act(async () => {
    appStateHandler?.("background");
    jest.setSystemTime(Date.now() + ms);
    appStateHandler?.("active");
  });
}

const LONG_AWAY = 120_000;

beforeEach(() => {
  freezeNow(new Date("2026-11-09T12:00:00.000Z"));
  appStateHandler = undefined;
  mockRemove.mockClear();
  mockedRpc.mockReset();
  mockedRpc.mockResolvedValue({ data: 0, error: null });
  mockedUseAuth.mockReturnValue({ user: { id: "u1" } });
  jest
    .spyOn(AppState, "addEventListener")
    .mockImplementation(((_type: string, handler: (state: string) => void) => {
      appStateHandler = handler;
      return { remove: mockRemove };
    }) as never);
  (AppState as { currentState: string }).currentState = "active";
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("useMaterialiseOnForeground", () => {
  it("catches up once when the app opens", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });

    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    expect(mockedRpc).toHaveBeenCalledWith("materialise_my_recurring");
  });

  it("catches up again after a real time in the background", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));

    await awayFor(LONG_AWAY);
    expect(mockedRpc).toHaveBeenCalledTimes(2);

    await awayFor(LONG_AWAY);
    expect(mockedRpc).toHaveBeenCalledTimes(3);
  });

  it("calls after exactly 30 s in the background once 60 s have passed since the last call", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    jest.setSystemTime(Date.now() + 60_000);

    await awayFor(30_000);

    expect(mockedRpc).toHaveBeenCalledTimes(2);
  });

  it("does not call for a short time in the background", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    jest.setSystemTime(Date.now() + 10 * 60_000);

    await awayFor(29_999);

    expect(mockedRpc).toHaveBeenCalledTimes(1);
  });

  it("does not call for an inactive blip, however long it lasts (notification shade, Face ID)", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    jest.setSystemTime(Date.now() + 10 * 60_000);

    await act(async () => {
      appStateHandler?.("inactive");
      jest.setSystemTime(Date.now() + 5 * 60_000);
      appStateHandler?.("active");
    });

    expect(mockedRpc).toHaveBeenCalledTimes(1);
  });

  it("starts the clock at the background, not at the inactive state before it", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    jest.setSystemTime(Date.now() + 10 * 60_000);

    await act(async () => {
      appStateHandler?.("inactive");
      jest.setSystemTime(Date.now() + 60_000);
      appStateHandler?.("background");
      jest.setSystemTime(Date.now() + 1_000);
      appStateHandler?.("active");
    });

    expect(mockedRpc).toHaveBeenCalledTimes(1);
  });

  it("does not call twice for one return, however many active events follow", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));

    await awayFor(LONG_AWAY);
    await act(async () => {
      jest.setSystemTime(Date.now() + LONG_AWAY);
      appStateHandler?.("active");
      appStateHandler?.("active");
    });

    expect(mockedRpc).toHaveBeenCalledTimes(2);
  });

  it("waits at least 60 s between calls even after a long background", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));

    await awayFor(40_000);
    expect(mockedRpc).toHaveBeenCalledTimes(1);

    await awayFor(40_000);
    expect(mockedRpc).toHaveBeenCalledTimes(2);

    await awayFor(59_999);
    expect(mockedRpc).toHaveBeenCalledTimes(2);
  });

  it("a call that never returns does not block later catch-ups for the session", async () => {
    mockedRpc.mockReturnValueOnce(new Promise(() => {}));
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));

    await awayFor(LONG_AWAY);
    expect(mockedRpc).toHaveBeenCalledTimes(2);

    await awayFor(LONG_AWAY);
    expect(mockedRpc).toHaveBeenCalledTimes(3);
  });

  it("does nothing when nobody is signed in", async () => {
    mockedUseAuth.mockReturnValue({ user: null });
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });

    await awayFor(LONG_AWAY);

    expect(mockedRpc).not.toHaveBeenCalled();
  });

  it("invalidates the activity, expense and balance queries when it created rows", async () => {
    mockedRpc.mockResolvedValue({ data: 2, error: null });
    const { Wrapper, keys } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });

    await waitFor(() => expect(keys().length).toBeGreaterThan(0));
    for (const key of [
      ["activity"],
      ["expenses"],
      ["contact-expenses"],
      ["balances"],
      ["total-balance"],
      ["recurring-schedules"],
    ]) {
      expect(keys()).toContain(JSON.stringify(key));
    }
  });

  it("invalidates nothing when it created no rows", async () => {
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("ignores a server error silently", async () => {
    mockedRpc.mockResolvedValue({ data: null, error: new Error("boom") });
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    await act(async () => {});

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("ignores a thrown network failure silently and still catches up next time", async () => {
    mockedRpc.mockRejectedValueOnce(new Error("offline"));
    const { Wrapper, invalidate } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(invalidate).not.toHaveBeenCalled();

    await awayFor(LONG_AWAY);
    expect(mockedRpc).toHaveBeenCalledTimes(2);
  });

  it("stops listening on unmount", async () => {
    const { Wrapper } = makeWrapper();
    const { unmount } = await renderHook(() => useMaterialiseOnForeground(), {
      wrapper: Wrapper,
    });
    await unmount();

    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
