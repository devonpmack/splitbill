import { fireEvent, screen } from "@testing-library/react-native";
import { actAsync, renderWithPaper } from "../helpers/testUtils";
import Repeating from "@/app/repeating";
import type { RecurringSchedule } from "@/lib/types";

const mockStop = jest.fn();
const mockConfirm = jest.fn();
const mockShowError = jest.fn();
const mockShowSuccess = jest.fn();
const mockParams: { groupId?: string; contactUserId?: string } = {};

jest.mock("expo-router", () => ({
  useLocalSearchParams: () => mockParams,
}));
jest.mock("@/lib/auth", () => ({ useAuth: jest.fn() }));
jest.mock("@/lib/queries/useGroups", () => ({ useGroup: jest.fn() }));
jest.mock("@/lib/queries/useContacts", () => ({ useContacts: jest.fn() }));
jest.mock("@/lib/queries/useRecurringSchedules", () => ({
  useRecurringSchedules: jest.fn(),
  useStopRecurringSchedule: jest.fn(),
}));
jest.mock("@/lib/snackbar", () => ({ useSnackbar: jest.fn() }));
jest.mock("@/lib/confirm", () => ({ useConfirm: jest.fn() }));

import { useAuth } from "@/lib/auth";
import { useGroup } from "@/lib/queries/useGroups";
import { useContacts } from "@/lib/queries/useContacts";
import {
  useRecurringSchedules,
  useStopRecurringSchedule,
} from "@/lib/queries/useRecurringSchedules";
import { useSnackbar } from "@/lib/snackbar";
import { useConfirm } from "@/lib/confirm";

const schedule = (over: Partial<RecurringSchedule> = {}): RecurringSchedule => ({
  id: "s1",
  kind: "group",
  group_id: "g1",
  user_lo: null,
  user_hi: null,
  created_by: "u1",
  paid_by: "u1",
  description: "Rent",
  category: null,
  amount: 1200,
  currency: "USD",
  last_exchange_rate: 1,
  split_type: "equal",
  splits: [],
  start_date: "2026-01-31",
  tz: "America/Toronto",
  frequency: "monthly",
  end_date: null,
  max_count: null,
  next_index: 1,
  stopped_at: null,
  stop_reason: null,
  created_at: "2026-01-31T00:00:00Z",
  last_error: null,
  failed_runs: 0,
  ...over,
});

function setSchedules(data: RecurringSchedule[] | undefined) {
  (useRecurringSchedules as jest.Mock).mockReturnValue({
    data,
    isLoading: data === undefined,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockParams.groupId = "g1";
  mockParams.contactUserId = undefined;
  (useAuth as jest.Mock).mockReturnValue({ user: { id: "u1" } });
  (useGroup as jest.Mock).mockReturnValue({
    data: {
      id: "g1",
      group_members: [
        { user_id: "u1", profiles: { full_name: "Me" } },
        { user_id: "u2", profiles: { full_name: "Bob" } },
      ],
    },
  });
  (useContacts as jest.Mock).mockReturnValue({
    data: [{ contact_user_id: "u2", full_name: "Bob" }],
  });
  (useStopRecurringSchedule as jest.Mock).mockReturnValue({
    mutate: mockStop,
    isPending: false,
  });
  (useSnackbar as jest.Mock).mockReturnValue({
    showError: mockShowError,
    showSuccess: mockShowSuccess,
  });
  (useConfirm as jest.Mock).mockReturnValue(mockConfirm);
  setSchedules([schedule()]);
});

describe("Repeating screen", () => {
  it("reads the group's schedules", async () => {
    await renderWithPaper(<Repeating />);

    expect(useRecurringSchedules).toHaveBeenCalledWith({
      kind: "group",
      groupId: "g1",
    });
  });

  it("reads a contact's schedules when opened from a contact", async () => {
    mockParams.groupId = undefined;
    mockParams.contactUserId = "u2";
    await renderWithPaper(<Repeating />);

    expect(useRecurringSchedules).toHaveBeenCalledWith({
      kind: "contact",
      contactUserId: "u2",
    });
  });

  it("lists an active schedule: description, amount, frequency, payer, next date, end", async () => {
    await renderWithPaper(<Repeating />);

    expect(screen.getByText("Rent")).toBeTruthy();
    expect(screen.getByText("$1200.00 · Monthly")).toBeTruthy();
    expect(screen.getByText("Paid by You")).toBeTruthy();
    expect(screen.getByText("Next: Feb 28, 2026")).toBeTruthy();
    expect(screen.getByText("Never ends")).toBeTruthy();
    expect(screen.getByText("Stop")).toBeTruthy();
  });

  it("names another member as the payer and shows a foreign currency", async () => {
    setSchedules([schedule({ paid_by: "u2", currency: "EUR", amount: 50 })]);
    await renderWithPaper(<Repeating />);

    expect(screen.getByText("Paid by Bob")).toBeTruthy();
    expect(screen.getByText(/€50\.00 · Monthly/)).toBeTruthy();
  });

  it("names the contact as the payer on a contact schedule", async () => {
    mockParams.groupId = undefined;
    mockParams.contactUserId = "u2";
    setSchedules([schedule({ kind: "contact", paid_by: "u2", group_id: null })]);
    await renderWithPaper(<Repeating />);

    expect(screen.getByText("Paid by Bob")).toBeTruthy();
  });

  describe("next occurrence", () => {
    it.each([
      ["clamps Jan 31 monthly to Feb 28", "2026-01-31", 1, "monthly", "Feb 28, 2026"],
      ["is back on the 31st after the clamp", "2026-01-31", 2, "monthly", "Mar 31, 2026"],
      ["lands on Feb 29 in a leap year", "2028-01-31", 1, "monthly", "Feb 29, 2028"],
      ["clamps a yearly Feb 29", "2028-02-29", 1, "yearly", "Feb 28, 2029"],
      ["steps every 2 weeks", "2026-11-09", 3, "biweekly", "Dec 21, 2026"],
      ["steps weekly", "2026-12-30", 1, "weekly", "Jan 6, 2027"],
      ["steps daily", "2026-12-31", 1, "daily", "Jan 1, 2027"],
    ] as const)("%s", async (_name, start, nextIndex, frequency, expected) => {
      setSchedules([
        schedule({ start_date: start, next_index: nextIndex, frequency }),
      ]);
      await renderWithPaper(<Repeating />);

      expect(screen.getByText(`Next: ${expected}`)).toBeTruthy();
    });

    it("shows no next date once the schedule has run out", async () => {
      setSchedules([schedule({ max_count: 2, next_index: 2 })]);
      await renderWithPaper(<Repeating />);

      expect(screen.queryByText(/^Next:/)).toBeNull();
    });
  });

  describe("end info", () => {
    it("shows the end date", async () => {
      setSchedules([schedule({ end_date: "2026-12-31" })]);
      await renderWithPaper(<Repeating />);

      expect(screen.getByText("Until Dec 31, 2026")).toBeTruthy();
    });

    it("shows how many are left", async () => {
      setSchedules([schedule({ max_count: 12, next_index: 5 })]);
      await renderWithPaper(<Repeating />);

      expect(screen.getByText("7 left")).toBeTruthy();
    });
  });

  it("says when the latest repeat could not be created", async () => {
    setSchedules([schedule({ failed_runs: 2, last_error: "boom" })]);
    await renderWithPaper(<Repeating />);

    expect(
      screen.getByText("The latest repeat could not be created. Trying again.")
    ).toBeTruthy();
  });

  describe("stopping", () => {
    it("confirms first and explains what stays and what goes", async () => {
      await renderWithPaper(<Repeating />);

      await fireEvent.press(screen.getByText("Stop"));

      expect(mockStop).not.toHaveBeenCalled();
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      const arg = mockConfirm.mock.calls[0][0];
      expect(arg.title).toBe('Stop repeating "Rent"?');
      expect(arg.message).toBe(
        "Future repeats that were created ahead of time will be removed. Past ones stay. Edited ones stay."
      );
      expect(arg.confirmText).toBe("Stop");
      expect(arg.destructive).toBe(true);
    });

    it("stops the schedule when confirmed", async () => {
      await renderWithPaper(<Repeating />);
      await fireEvent.press(screen.getByText("Stop"));

      await actAsync(async () => {
        mockConfirm.mock.calls[0][0].onConfirm();
      });

      expect(mockStop).toHaveBeenCalledWith(
        { scheduleId: "s1", scope: { kind: "group", groupId: "g1" } },
        expect.objectContaining({
          onError: expect.any(Function),
          onSuccess: expect.any(Function),
        })
      );
    });

    it("stops a contact schedule in the contact's scope", async () => {
      mockParams.groupId = undefined;
      mockParams.contactUserId = "u2";
      await renderWithPaper(<Repeating />);
      await fireEvent.press(screen.getByText("Stop"));

      await actAsync(async () => {
        mockConfirm.mock.calls[0][0].onConfirm();
      });

      expect(mockStop.mock.calls[0][0].scope).toEqual({
        kind: "contact",
        contactUserId: "u2",
      });
    });

    it("says so when it worked and shows the server's error when it did not", async () => {
      await renderWithPaper(<Repeating />);
      await fireEvent.press(screen.getByText("Stop"));
      await actAsync(async () => {
        mockConfirm.mock.calls[0][0].onConfirm();
      });
      const options = mockStop.mock.calls[0][1];

      options.onSuccess();
      expect(mockShowSuccess).toHaveBeenCalledWith("Stopped repeating");

      options.onError(new Error("Not authenticated"));
      expect(mockShowError).toHaveBeenCalledWith("Not authenticated");
    });

    it("does not offer to stop twice while a stop is running", async () => {
      (useStopRecurringSchedule as jest.Mock).mockReturnValue({
        mutate: mockStop,
        isPending: true,
      });
      await renderWithPaper(<Repeating />);

      await fireEvent.press(screen.getByText("Stop"));

      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  describe("empty and loading", () => {
    it("shows an empty state when nothing repeats", async () => {
      setSchedules([]);
      await renderWithPaper(<Repeating />);

      expect(screen.getByText("Nothing repeats yet")).toBeTruthy();
      expect(
        screen.getByText("Pick a repeat when adding an expense to set one up.")
      ).toBeTruthy();
      expect(screen.queryByText(/^Stopped/)).toBeNull();
    });

    it("shows no empty state while loading", async () => {
      setSchedules(undefined);
      await renderWithPaper(<Repeating />);

      expect(screen.queryByText("Nothing repeats yet")).toBeNull();
    });

    it("still says nothing is active when only stopped ones exist", async () => {
      setSchedules([
        schedule({
          stopped_at: "2026-03-01T00:00:00Z",
          stop_reason: "stopped",
        }),
      ]);
      await renderWithPaper(<Repeating />);

      expect(screen.getByText("Nothing repeats yet")).toBeTruthy();
      expect(screen.getByText("Stopped (1)")).toBeTruthy();
    });
  });

  describe("stopped section", () => {
    const stopped = [
      schedule({
        id: "s2",
        description: "Gym",
        stopped_at: "2026-03-01T00:00:00Z",
        stop_reason: "completed",
      }),
      schedule({
        id: "s3",
        description: "Netflix",
        stopped_at: "2026-03-01T00:00:00Z",
        stop_reason: "member left",
      }),
      schedule({
        id: "s4",
        description: "Parking",
        stopped_at: "2026-03-01T00:00:00Z",
        stop_reason: "invalid",
      }),
      schedule({
        id: "s5",
        description: "Phone",
        stopped_at: "2026-03-01T00:00:00Z",
        stop_reason: "stopped",
      }),
    ];

    it("is collapsed, counts the stopped schedules, and keeps active ones apart", async () => {
      setSchedules([schedule(), ...stopped]);
      await renderWithPaper(<Repeating />);

      expect(screen.getByText("Stopped (4)")).toBeTruthy();
      expect(screen.getByText("Rent")).toBeTruthy();
      expect(screen.queryByText("Gym")).toBeNull();
      expect(screen.queryByText("Netflix")).toBeNull();
    });

    it("says why each one stopped in plain words, with no Stop button", async () => {
      setSchedules([...stopped]);
      await renderWithPaper(<Repeating />);

      await fireEvent.press(screen.getByText("Stopped (4)"));

      expect(screen.getByText("Gym")).toBeTruthy();
      expect(screen.getByText("Finished")).toBeTruthy();
      expect(screen.getByText("A member left")).toBeTruthy();
      expect(screen.getByText("Could not be created")).toBeTruthy();
      expect(screen.getByText("Stopped")).toBeTruthy();
      expect(screen.queryByText("Stop")).toBeNull();
      expect(screen.queryByText(/^Next:/)).toBeNull();
    });
  });
});
