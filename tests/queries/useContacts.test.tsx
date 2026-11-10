import { renderHook, waitFor } from "@testing-library/react-native";
import { createWrapper } from "../helpers/testUtils";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth";
import {
  useContacts,
  useContactBalance,
  useContactPairBalance,
  useContactGroupBreakdown,
} from "@/lib/queries/useContacts";

jest.mock("@/lib/supabase", () => ({
  supabase: { from: jest.fn(), rpc: jest.fn() },
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));

const mockedSupabase = supabase as unknown as {
  from: jest.Mock;
  rpc: jest.Mock;
};
const mockedUseAuth = useAuth as unknown as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockedUseAuth.mockReturnValue({ user: { id: "user-1", email: "me@x.com" } });
});

describe("useContacts", () => {
  it("returns contacts with numeric balances from the RPC", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: [
        {
          contact_user_id: "user-2",
          full_name: "Bob",
          avatar_url: null,
          currency: "USD",
          balance: "12.5",
          is_accepted: true,
        },
      ],
      error: null,
    });

    const { result } = await renderHook(() => useContacts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "get_contacts_with_combined_balances"
    );
    expect(result.current.data).toEqual([
      {
        contact_user_id: "user-2",
        full_name: "Bob",
        avatar_url: null,
        balance: 12.5,
        is_accepted: true,
        deleted_at: null,
      },
    ]);
  });

  it("carries the contact's deleted_at, and treats a missing key as not deleted", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: [
        {
          contact_user_id: "user-2",
          full_name: "Deleted user",
          avatar_url: null,
          currency: "USD",
          balance: "5",
          is_accepted: true,
          contact_deleted_at: "2026-11-01T00:00:00Z",
        },
        {
          // A database that predates the column returns no such key.
          contact_user_id: "user-3",
          full_name: "Cara",
          avatar_url: null,
          currency: "USD",
          balance: "1",
          is_accepted: true,
        },
      ],
      error: null,
    });

    const { result } = await renderHook(() => useContacts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      result.current.data?.map((c) => [c.contact_user_id, c.deleted_at])
    ).toEqual([
      ["user-2", "2026-11-01T00:00:00Z"],
      ["user-3", null],
    ]);
  });

  it("reports an unknown balance instead of an unconverted one", async () => {
    // SEK has no rate in the test fixture, so the combined balance cannot be
    // expressed in the display currency.
    mockedSupabase.rpc.mockResolvedValue({
      data: [
        {
          contact_user_id: "user-2",
          full_name: "Bob",
          avatar_url: null,
          currency: "USD",
          balance: "10",
          is_accepted: true,
        },
        {
          contact_user_id: "user-2",
          full_name: "Bob",
          avatar_url: null,
          currency: "SEK",
          balance: "100",
          is_accepted: true,
        },
      ],
      error: null,
    });

    const { result } = await renderHook(() => useContacts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      expect.objectContaining({ contact_user_id: "user-2", balance: null }),
    ]);
  });
});

describe("useContactBalance", () => {
  it("sums the per-currency contexts into a display-currency balance", async () => {
    // -5 EUR (rate 0.5) = -10 USD, plus a -2 USD shared-group piece = -12 USD.
    mockedSupabase.rpc.mockResolvedValue({
      data: [
        { currency: "EUR", balance: -5 },
        { currency: "USD", balance: -2 },
      ],
      error: null,
    });

    const { result } = await renderHook(() => useContactBalance("user-2"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "get_contact_balance_contexts",
      {
        p_contact_user_id: "user-2",
      }
    );
    expect(result.current.data).toBe(-12);
  });
});

describe("useContactPairBalance", () => {
  it("returns the one-on-one ledger balance without display-currency conversion", async () => {
    mockedSupabase.rpc.mockResolvedValue({ data: "15.25", error: null });

    const { result } = await renderHook(
      () => useContactPairBalance("user-2"),
      {
        wrapper: createWrapper(),
      }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.rpc).toHaveBeenCalledWith("get_contact_balance", {
      p_contact_user_id: "user-2",
    });
    expect(result.current.data).toBe(15.25);
  });
});

describe("useContactGroupBreakdown", () => {
  it("returns per-group pairwise balances with numeric amounts", async () => {
    mockedSupabase.rpc.mockResolvedValue({
      data: [
        { group_id: "g1", group_name: "Ski Trip", balance: "25.5" },
        { group_id: "g2", group_name: "Roomies", balance: "-10" },
      ],
      error: null,
    });

    const { result } = await renderHook(
      () => useContactGroupBreakdown("user-2"),
      { wrapper: createWrapper() }
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockedSupabase.rpc).toHaveBeenCalledWith(
      "get_contact_group_breakdown",
      { p_contact_user_id: "user-2" }
    );
    expect(result.current.data).toEqual([
      { group_id: "g1", group_name: "Ski Trip", balance: 25.5 },
      { group_id: "g2", group_name: "Roomies", balance: -10 },
    ]);
  });

});
