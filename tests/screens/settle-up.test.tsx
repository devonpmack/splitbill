import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { freezeNow, renderWithPaper } from "../helpers/testUtils";
import { startOfLocalDayISO } from "@/lib/dates";
import SettleUp from "@/app/group-settle-up";

const mockBack = jest.fn();
const mockPayAsync = jest.fn();
const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => ({ groupId: "g1" }),
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useBalances", () => ({
  useGroupPairwiseBalances: jest.fn(),
  useGroupSimplifiedEdges: jest.fn(),
}));
jest.mock("@/lib/queries/useGroups", () => ({ useGroup: jest.fn() }));
jest.mock("@/lib/queries/usePayments", () => ({ useCreatePayment: jest.fn() }));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import {
  useGroupPairwiseBalances,
  useGroupSimplifiedEdges,
} from "@/lib/queries/useBalances";
import { useGroup } from "@/lib/queries/useGroups";
import { useCreatePayment } from "@/lib/queries/usePayments";
import { useSnackbar } from "@/lib/snackbar";

const meOwesBobEdge = {
  from: "u1",
  from_name: "Me",
  to: "u2",
  to_name: "Bob",
  amount: 20,
};

const splitOwingEdges = [
  meOwesBobEdge,
  {
    from: "u1",
    from_name: "Me",
    to: "u3",
    to_name: "Cara",
    amount: 10,
  },
];

function setSimplifiedEdges(edges: unknown) {
  (useGroupSimplifiedEdges as jest.Mock).mockReturnValue({
    data: edges,
    refetch: jest.fn(),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPayAsync.mockResolvedValue({ id: "pay-1" });
  (router as unknown as { back: jest.Mock }).back = mockBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "u1" } });
  (useGroup as jest.Mock).mockReturnValue({
    data: { currency: "USD", simplify_debts: true },
  });
  (useGroupPairwiseBalances as jest.Mock).mockReturnValue({ data: [] });
  setSimplifiedEdges([meOwesBobEdge]);
  (useCreatePayment as jest.Mock).mockReturnValue({
    mutateAsync: mockPayAsync,
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({
    showError: mockShowError,
    showSuccess: mockShowSuccess,
  });
});

describe("SettleUp screen", () => {
  it("shows the settled-up message when there are no debts", async () => {
    setSimplifiedEdges([]);
    await renderWithPaper(<SettleUp />);

    expect(
      screen.getByText("You're all settled up in this group!")
    ).toBeTruthy();
  });

  it("does not claim settled up while the debts are loading", async () => {
    setSimplifiedEdges(undefined);
    await renderWithPaper(<SettleUp />);

    expect(
      screen.queryByText("You're all settled up in this group!")
    ).toBeNull();
  });

  it("records a payment for the selected debt with the auto-filled amount", async () => {
    await renderWithPaper(<SettleUp />);

    await fireEvent.press(screen.getByTestId("debt-card-u1-u2"));
    await fireEvent.press(screen.getByText("Record Payment"));

    await waitFor(() =>
      expect(mockPayAsync).toHaveBeenCalledWith({
        groupId: "g1",
        paidBy: "u1",
        paidTo: "u2",
        amount: 20,
        note: undefined,
        currency: "USD",
      })
    );
    expect(mockShowSuccess).toHaveBeenCalledWith("Payment recorded!");
    expect(mockBack).toHaveBeenCalled();
  });

  describe("date", () => {
    beforeEach(() => freezeNow(new Date(2026, 10, 9, 15, 0)));
    afterEach(() => jest.useRealTimers());

    it("records a payment on a picked future day", async () => {
      await renderWithPaper(<SettleUp />);

      await fireEvent.press(screen.getByTestId("debt-card-u1-u2"));
      expect(screen.getByTestId("date-field")).toHaveProp("value", "11/09/2026");
      await fireEvent.changeText(screen.getByTestId("date-field"), "11/12/2026");
      expect(
        screen.getByText("Counts toward balances from Nov 12, 2026.")
      ).toBeTruthy();
      await fireEvent.press(screen.getByText("Record Payment"));

      await waitFor(() =>
        expect(mockPayAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            date: startOfLocalDayISO(new Date(2026, 10, 12)),
          })
        )
      );
    });

    it("refuses to record a payment with an incomplete date", async () => {
      await renderWithPaper(<SettleUp />);

      await fireEvent.press(screen.getByTestId("debt-card-u1-u2"));
      await fireEvent(screen.getByTestId("date-field"), "change", {
        nativeEvent: { text: "11/1" },
      });
      await fireEvent.press(screen.getByText("Record Payment"));

      expect(mockShowError).toHaveBeenCalledWith("Please enter a valid date");
      expect(mockPayAsync).not.toHaveBeenCalled();
    });
  });

  it("uses raw pairwise edges when simplification is off", async () => {
    (useGroup as jest.Mock).mockReturnValue({
      data: { currency: "USD", simplify_debts: false },
    });
    // Net balances would simplify Me -> Cara, but the raw ledger has Me owing
    // Bob directly. With simplification off we must settle along the raw edge.
    setSimplifiedEdges([]);
    (useGroupPairwiseBalances as jest.Mock).mockReturnValue({
      data: [
        { from: "u1", from_name: "Me", to: "u2", to_name: "Bob", amount: 25 },
      ],
    });

    await renderWithPaper(<SettleUp />);

    await fireEvent.press(screen.getByTestId("debt-card-u1-u2"));
    await fireEvent.press(screen.getByText("Record Payment"));

    await waitFor(() =>
      expect(mockPayAsync).toHaveBeenCalledWith({
        groupId: "g1",
        paidBy: "u1",
        paidTo: "u2",
        amount: 25,
        note: undefined,
        currency: "USD",
      })
    );
  });

  it("keeps the selected debt when balances refetch in a different order", async () => {
    setSimplifiedEdges(splitOwingEdges);
    const view = await renderWithPaper(<SettleUp />);

    await fireEvent.press(screen.getByTestId("debt-card-u1-u2"));
    await waitFor(() => expect(screen.getByText("Record Payment")).toBeTruthy());
    setSimplifiedEdges([splitOwingEdges[1], splitOwingEdges[0]]);
    await act(async () => {
      view.rerender(<SettleUp />);
    });
    await fireEvent.press(screen.getByText("Record Payment"));

    await waitFor(() =>
      expect(mockPayAsync).toHaveBeenCalledWith({
        groupId: "g1",
        paidBy: "u1",
        paidTo: "u2",
        amount: 20,
        note: undefined,
        currency: "USD",
      })
    );
  });

  it("includes a trimmed note when one is entered", async () => {
    await renderWithPaper(<SettleUp />);

    await fireEvent.press(screen.getByText("$20.00"));
    await fireEvent.changeText(
      screen.getByPlaceholderText("e.g., Venmo payment"),
      "  Venmo  "
    );
    await fireEvent.press(screen.getByText("Record Payment"));

    await waitFor(() =>
      expect(mockPayAsync).toHaveBeenCalledWith(
        expect.objectContaining({ note: "Venmo" })
      )
    );
  });

  it("rejects a non-positive amount", async () => {
    await renderWithPaper(<SettleUp />);

    await fireEvent.press(screen.getByText("$20.00"));
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "-5");
    await fireEvent.press(screen.getByText("Record Payment"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a valid amount");
    expect(mockPayAsync).not.toHaveBeenCalled();
  });

  it("rejects an explicit zero amount instead of falling back to the full debt", async () => {
    await renderWithPaper(<SettleUp />);

    await fireEvent.press(screen.getByText("$20.00"));
    await fireEvent.changeText(screen.getByPlaceholderText("0.00"), "0");
    await fireEvent.press(screen.getByText("Record Payment"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a valid amount");
    expect(mockPayAsync).not.toHaveBeenCalled();
  });

  it("surfaces an error when recording the payment fails", async () => {
    mockPayAsync.mockRejectedValue({});
    await renderWithPaper(<SettleUp />);

    await fireEvent.press(screen.getByText("$20.00"));
    await fireEvent.press(screen.getByText("Record Payment"));

    await waitFor(() =>
      expect(mockShowError).toHaveBeenCalledWith(
        "Couldn't record payment. Please try again."
      )
    );
    expect(mockBack).not.toHaveBeenCalled();
  });
});
