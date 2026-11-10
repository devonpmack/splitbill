import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { freezeNow, renderWithPaper } from "../helpers/testUtils";
import { startOfLocalDayISO } from "@/lib/dates";
import { ContactSettleUpScreen as ContactSettleUp } from "@/components/contacts/ContactSettleUpScreen";

const mockBack = jest.fn();
const mockCreateAsync = jest.fn();
const mockUpdateAsync = jest.fn();
const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();
const mockParams: { contactUserId: string; paymentId?: string } = {
  contactUserId: "user-2",
};

jest.mock("expo-router", () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => mockParams,
  Stack: { Screen: () => null },
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useContacts", () => ({
  useContacts: jest.fn(),
  useContactBalance: jest.fn(),
  useContactCurrency: jest.fn(),
  useContactPairBalance: jest.fn(),
}));
jest.mock("@/lib/queries/useContactPayments", () => ({
  useContactPayments: jest.fn(),
  useCreateContactPayment: jest.fn(),
  useUpdateContactPayment: jest.fn(),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import {
  useContacts,
  useContactBalance,
  useContactCurrency,
  useContactPairBalance,
} from "@/lib/queries/useContacts";
import {
  useContactPayments,
  useCreateContactPayment,
  useUpdateContactPayment,
} from "@/lib/queries/useContactPayments";
import { useSnackbar } from "@/lib/snackbar";

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.contactUserId = "user-2";
  mockParams.paymentId = undefined;
  mockCreateAsync.mockResolvedValue({ id: "cp-1" });
  mockUpdateAsync.mockResolvedValue({ id: "cp-1" });
  (router as unknown as { back: jest.Mock }).back = mockBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "user-1" } });
  (useContacts as jest.Mock).mockReturnValue({
    data: [{ contact_user_id: "user-2", full_name: "Bob", balance: 15 }],
  });
  (useContactBalance as jest.Mock).mockReturnValue({ data: 15 });
  (useContactCurrency as jest.Mock).mockReturnValue({ data: "USD" });
  (useContactPairBalance as jest.Mock).mockReturnValue({
    data: 15,
    isSuccess: true,
  });
  (useContactPayments as jest.Mock).mockReturnValue({ data: [] });
  (useCreateContactPayment as jest.Mock).mockReturnValue({
    mutateAsync: mockCreateAsync,
    isPending: false,
  });
  (useUpdateContactPayment as jest.Mock).mockReturnValue({
    mutateAsync: mockUpdateAsync,
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({
    showError: mockShowError,
    showSuccess: mockShowSuccess,
  });
});

describe("ContactSettleUp screen (create)", () => {
  it("defaults the amount to the outstanding balance", async () => {
    await renderWithPaper(<ContactSettleUp />);

    expect(screen.getByDisplayValue("15.00")).toBeTruthy();
    expect(screen.getByText("Bob owes you $15.00")).toBeTruthy();
  });

  it("records a payment from the contact when they owe you", async () => {
    await renderWithPaper(<ContactSettleUp />);

    await fireEvent.press(screen.getByText("Record Payment"));

    await waitFor(() => expect(mockCreateAsync).toHaveBeenCalledTimes(1));
    // balance > 0 => contact owes you => default direction is they paid you.
    expect(mockCreateAsync).toHaveBeenCalledWith({
      contactUserId: "user-2",
      paidBy: "user-2",
      paidTo: "user-1",
      amount: 15,
      note: undefined,
      currency: "USD",
    });
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it("does not prefill from a zero default while the balance is loading", async () => {
    (useContactPairBalance as jest.Mock).mockReturnValue({
      data: undefined,
      isSuccess: false,
    });

    await renderWithPaper(<ContactSettleUp />);

    expect(screen.getByText("Loading balance\u2026")).toBeTruthy();
    expect(screen.queryByDisplayValue("0.00")).toBeNull();
  });

  it("prefills once the balance arrives after the first render", async () => {
    (useContactPairBalance as jest.Mock).mockReturnValue({
      data: undefined,
      isSuccess: false,
    });
    const view = await renderWithPaper(<ContactSettleUp />);

    (useContactPairBalance as jest.Mock).mockReturnValue({
      data: 15,
      isSuccess: true,
    });
    view.rerender(<ContactSettleUp />);

    await waitFor(() =>
      expect(screen.getByDisplayValue("15.00")).toBeTruthy()
    );
    await fireEvent.press(screen.getByText("Record Payment"));

    await waitFor(() => expect(mockCreateAsync).toHaveBeenCalledTimes(1));
    expect(mockCreateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ paidBy: "user-2", paidTo: "user-1" })
    );
  });

  describe("date", () => {
    beforeEach(() => freezeNow(new Date(2026, 10, 9, 15, 0)));
    afterEach(() => jest.useRealTimers());

    it("records a payment on a picked future day", async () => {
      await renderWithPaper(<ContactSettleUp />);

      await fireEvent.changeText(screen.getByTestId("date-field"), "11/12/2026");
      expect(
        screen.getByText("Counts toward balances from Nov 12, 2026.")
      ).toBeTruthy();
      await fireEvent.press(screen.getByText("Record Payment"));

      await waitFor(() =>
        expect(mockCreateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            date: startOfLocalDayISO(new Date(2026, 10, 12)),
          })
        )
      );
    });
  });

  it("rejects an invalid amount", async () => {
    await renderWithPaper(<ContactSettleUp />);

    await fireEvent.changeText(screen.getByDisplayValue("15.00"), "0");
    await fireEvent.press(screen.getByText("Record Payment"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a valid amount");
    expect(mockCreateAsync).not.toHaveBeenCalled();
  });
});

describe("ContactSettleUp screen (edit)", () => {
  beforeEach(() => {
    mockParams.paymentId = "cp-1";
    (useContactPayments as jest.Mock).mockReturnValue({
      data: [
        {
          id: "cp-1",
          paid_by: "user-1",
          paid_to: "user-2",
          amount: 8,
          note: "cash",
          date: new Date(2026, 10, 5, 15).toISOString(),
        },
      ],
    });
  });

  it("prefills from the existing payment and updates it", async () => {
    await renderWithPaper(<ContactSettleUp />);

    expect(screen.getByDisplayValue("8.00")).toBeTruthy();
    expect(screen.getByDisplayValue("cash")).toBeTruthy();

    await fireEvent.press(screen.getByText("Save Changes"));

    await waitFor(() => expect(mockUpdateAsync).toHaveBeenCalledTimes(1));
    expect(mockUpdateAsync).toHaveBeenCalledWith({
      paymentId: "cp-1",
      contactUserId: "user-2",
      paidBy: "user-1",
      paidTo: "user-2",
      amount: 8,
      note: "cash",
      currency: "USD",
    });
  });

  describe("date", () => {
    beforeEach(() => freezeNow(new Date(2026, 10, 9, 15, 0)));
    afterEach(() => jest.useRealTimers());

    it("prefills the stored day and sends no date when unchanged", async () => {
      await renderWithPaper(<ContactSettleUp />);

      expect(screen.getByTestId("date-field")).toHaveProp("value", "11/05/2026");
      await fireEvent.press(screen.getByText("Save Changes"));

      await waitFor(() => expect(mockUpdateAsync).toHaveBeenCalledTimes(1));
      expect(mockUpdateAsync.mock.calls[0][0].date).toBeUndefined();
    });

    it("sends the start of a newly picked day", async () => {
      await renderWithPaper(<ContactSettleUp />);

      await fireEvent.changeText(screen.getByTestId("date-field"), "10/30/2026");
      await fireEvent.press(screen.getByText("Save Changes"));

      await waitFor(() =>
        expect(mockUpdateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            paymentId: "cp-1",
            date: startOfLocalDayISO(new Date(2026, 9, 30)),
          })
        )
      );
    });
  });
});
