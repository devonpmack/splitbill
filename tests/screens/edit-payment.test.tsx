import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import { freezeNow, renderWithPaper } from "../helpers/testUtils";
import { startOfLocalDayISO } from "@/lib/dates";
import EditPayment from "@/app/group-edit-payment";

const mockBack = jest.fn();
const mockMutateAsync = jest.fn();
const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();

jest.mock("expo-router", () => ({
  router: { back: jest.fn() },
  useLocalSearchParams: () => ({ groupId: "g1", paymentId: "p1" }),
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useGroups", () => ({ useGroup: jest.fn() }));
jest.mock("@/lib/queries/usePayments", () => ({
  useGroupPayments: jest.fn(),
  useUpdatePayment: jest.fn(),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));

import { router } from "expo-router";
import { useAuth } from "@/lib/auth";
import { useGroup } from "@/lib/queries/useGroups";
import { useGroupPayments, useUpdatePayment } from "@/lib/queries/usePayments";
import { useSnackbar } from "@/lib/snackbar";

const group = {
  id: "g1",
  name: "Trip",
  group_members: [
    { user_id: "u1", profiles: { full_name: "Me" } },
    { user_id: "u2", profiles: { full_name: "Bob" } },
  ],
};
const payment = {
  id: "p1",
  paid_by: "u1",
  paid_to: "u2",
  amount: 20,
  note: "Venmo",
  created_at: "2024-01-02",
  date: "2026-11-05T15:00:00Z",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockMutateAsync.mockResolvedValue({ id: "p1" });
  (router as unknown as { back: jest.Mock }).back = mockBack;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "u1" } });
  (useGroup as jest.Mock).mockReturnValue({ data: group });
  (useGroupPayments as jest.Mock).mockReturnValue({ data: [payment] });
  (useUpdatePayment as jest.Mock).mockReturnValue({
    mutateAsync: mockMutateAsync,
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({
    showError: mockShowError,
    showSuccess: mockShowSuccess,
  });
});

describe("EditPayment screen", () => {
  it("submits the update with the mapped direction and amount", async () => {
    await renderWithPaper(<EditPayment />);

    await fireEvent.press(screen.getByText("Save Changes"));

    await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
    expect(mockMutateAsync).toHaveBeenCalledWith({
      paymentId: "p1",
      groupId: "g1",
      paidBy: "u1",
      paidTo: "u2",
      amount: 20,
      note: "Venmo",
    });
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  describe("date", () => {
    beforeEach(() => freezeNow(new Date(2026, 10, 9, 15, 0)));
    afterEach(() => jest.useRealTimers());

    it("prefills the stored day and keeps it when unchanged", async () => {
      await renderWithPaper(<EditPayment />);

      expect(screen.getByTestId("date-field")).toHaveProp("value", "11/05/2026");
      await fireEvent.press(screen.getByText("Save Changes"));

      await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledTimes(1));
      expect(mockMutateAsync.mock.calls[0][0].date).toBeUndefined();
    });

    it("sends the start of a newly picked day", async () => {
      await renderWithPaper(<EditPayment />);

      await fireEvent.changeText(screen.getByTestId("date-field"), "11/12/2026");
      await fireEvent.press(screen.getByText("Save Changes"));

      await waitFor(() =>
        expect(mockMutateAsync).toHaveBeenCalledWith(
          expect.objectContaining({
            paymentId: "p1",
            date: startOfLocalDayISO(new Date(2026, 10, 12)),
          })
        )
      );
    });
  });

  it("rejects an invalid amount", async () => {
    await renderWithPaper(<EditPayment />);

    await fireEvent.changeText(screen.getByDisplayValue("20.00"), "0");
    await fireEvent.press(screen.getByText("Save Changes"));

    expect(mockShowError).toHaveBeenCalledWith("Please enter a valid amount");
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });
});
