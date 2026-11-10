import React from "react";
import { AppState } from "react-native";
import { act, renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import { useMaterialiseOnForeground } from "@/lib/useMaterialiseOnForeground";

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

async function foreground() {
  await act(async () => {
    appStateHandler?.("background");
    appStateHandler?.("active");
  });
}

beforeEach(() => {
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
  jest.restoreAllMocks();
});

describe("useMaterialiseOnForeground", () => {
  it("catches up once when the app opens", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });

    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));
    expect(mockedRpc).toHaveBeenCalledWith("materialise_my_recurring");
  });

  it("catches up once per return to the foreground", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));

    await foreground();
    expect(mockedRpc).toHaveBeenCalledTimes(2);

    await foreground();
    expect(mockedRpc).toHaveBeenCalledTimes(3);
  });

  it("does not call again while the app stays active or goes to the background", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));

    await act(async () => {
      appStateHandler?.("active");
      appStateHandler?.("active");
      appStateHandler?.("background");
    });

    expect(mockedRpc).toHaveBeenCalledTimes(1);
  });

  it("treats inactive to active as a return to the foreground", async () => {
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));

    await act(async () => {
      appStateHandler?.("inactive");
      appStateHandler?.("active");
    });

    expect(mockedRpc).toHaveBeenCalledTimes(2);
  });

  it("does not start a second call while one is still running", async () => {
    let finish: (value: { data: number; error: null }) => void = () => {};
    mockedRpc.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });
    await waitFor(() => expect(mockedRpc).toHaveBeenCalledTimes(1));

    await foreground();
    expect(mockedRpc).toHaveBeenCalledTimes(1);

    await act(async () => finish({ data: 0, error: null }));
    await foreground();
    expect(mockedRpc).toHaveBeenCalledTimes(2);
  });

  it("does nothing when nobody is signed in", async () => {
    mockedUseAuth.mockReturnValue({ user: null });
    const { Wrapper } = makeWrapper();
    await renderHook(() => useMaterialiseOnForeground(), { wrapper: Wrapper });

    await foreground();

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

    await foreground();
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
