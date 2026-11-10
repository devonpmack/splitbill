import { renderHook, waitFor } from "@testing-library/react-native";
import { actAsync, createWrapper } from "../helpers/testUtils";
import { DeletedButStillSignedInError } from "@/lib/delete-account";
import {
  useDeleteAccount,
  useMyOpenBalances,
} from "@/lib/queries/useDeleteAccount";

const mockRpc = jest.fn();
const mockSignOut = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabase: {
    rpc: (...args: unknown[]) => mockRpc(...args),
    auth: { signOut: (...args: unknown[]) => mockSignOut(...args) },
  },
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useGroups", () => ({ useGroups: jest.fn() }));

import { useAuth } from "@/lib/auth";
import { useGroups } from "@/lib/queries/useGroups";

beforeEach(() => {
  jest.clearAllMocks();
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "u1" } });
  mockSignOut.mockResolvedValue({ error: null });
});

describe("useDeleteAccount", () => {
  it("calls delete_my_account with no arguments, then signs out on this device only", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    const { result } = await renderHook(() => useDeleteAccount(), {
      wrapper: createWrapper(),
    });

    await actAsync(() => result.current.mutateAsync());

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("delete_my_account");
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("does not sign out when the RPC fails, and rethrows its message", async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: "Could not delete the account" },
    });
    const { result } = await renderHook(() => useDeleteAccount(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() => result.current.mutateAsync())
    ).rejects.toThrow("Could not delete the account");

    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("says the account is gone but this device is still signed in when the sign-out throws", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockSignOut.mockRejectedValue(new Error("network down"));
    const { result } = await renderHook(() => useDeleteAccount(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() => result.current.mutateAsync())
    ).rejects.toBeInstanceOf(DeletedButStillSignedInError);

    expect(mockSignOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("says the same when the sign-out returns an error instead of throwing", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockSignOut.mockResolvedValue({ error: { message: "fetch failed" } });
    const { result } = await renderHook(() => useDeleteAccount(), {
      wrapper: createWrapper(),
    });

    await expect(
      actAsync(() => result.current.mutateAsync())
    ).rejects.toBeInstanceOf(DeletedButStillSignedInError);
  });
});

describe("useMyOpenBalances", () => {
  it("lists the groups where my balance is not zero, with the group's currency", async () => {
    (useGroups as jest.Mock).mockReturnValue({
      data: [
        { id: "g1", name: "Trip", currency: "USD" },
        { id: "g2", name: "Flat", currency: "EUR" },
        { id: "g3", name: "Lunch", currency: "GBP" },
      ],
      isLoading: false,
      isPending: false,
      isSuccess: true,
      isError: false,
    });
    mockRpc.mockImplementation((fn: string, args: { p_group_id: string }) => {
      expect(fn).toBe("get_group_balances");
      const rows: Record<string, unknown[]> = {
        g1: [
          { user_id: "u1", full_name: "Me", balance: "-12.50" },
          { user_id: "u2", full_name: "Bo", balance: "12.50" },
        ],
        g2: [{ user_id: "u1", full_name: "Me", balance: 0 }],
        g3: [
          { user_id: "u2", full_name: "Bo", balance: -7 },
          { user_id: "u1", full_name: "Me", balance: 7 },
        ],
      };
      return Promise.resolve({ data: rows[args.p_group_id], error: null });
    });

    const { result } = await renderHook(() => useMyOpenBalances(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { groupId: "g1", groupName: "Trip", currency: "USD", balance: -12.5 },
      { groupId: "g3", groupName: "Lunch", currency: "GBP", balance: 7 },
    ]);
  });

  it("is an empty list when I am in no groups", async () => {
    (useGroups as jest.Mock).mockReturnValue({
      data: [],
      isLoading: false,
      isPending: false,
      isSuccess: true,
      isError: false,
    });

    const { result } = await renderHook(() => useMyOpenBalances(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("is pending, not empty, while the group list is still loading", async () => {
    (useGroups as jest.Mock).mockReturnValue({
      data: undefined,
      isLoading: true,
      isPending: true,
      isSuccess: false,
      isError: false,
    });

    const { result } = await renderHook(() => useMyOpenBalances(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isPending).toBe(true);
    expect(result.current.isError).toBe(false);
    expect(result.current.data).toBeUndefined();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("reports an error, not an endless wait, when the group list fails", async () => {
    (useGroups as jest.Mock).mockReturnValue({
      data: undefined,
      isPending: false,
      isSuccess: false,
      isError: true,
    });

    const { result } = await renderHook(() => useMyOpenBalances(), {
      wrapper: createWrapper(),
    });

    expect(result.current.isError).toBe(true);
    expect(result.current.isPending).toBe(false);
  });

  it("reports an error when a group's balances cannot be read", async () => {
    (useGroups as jest.Mock).mockReturnValue({
      data: [{ id: "g1", name: "Trip", currency: "USD" }],
      isLoading: false,
      isPending: false,
      isSuccess: true,
      isError: false,
    });
    mockRpc.mockResolvedValue({ data: null, error: { message: "boom" } });

    const { result } = await renderHook(() => useMyOpenBalances(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
