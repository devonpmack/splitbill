import { screen } from "@testing-library/react-native";
import { renderWithPaper } from "../helpers/testUtils";
import { ExpenseCard } from "@/components/groups/ExpenseCard";
import { ActivityFeedItemCard } from "@/components/activity/ActivityFeedItem";
import { formatDay } from "@/lib/dates";
import type {
  ActivityContactExpense,
  ActivityExpense,
  ExpenseWithSplits,
} from "@/lib/types";

jest.mock("expo-router", () => ({ router: { push: jest.fn() } }));
jest.mock("@/lib/queries/useRecurringSchedules", () => ({
  useScheduleFrequencies: jest.fn(),
}));

import { useScheduleFrequencies } from "@/lib/queries/useRecurringSchedules";

// The instant Auckland's Dec 1 starts: Nov 30 in Vancouver, Dec 1 in Auckland.
// The row says Dec 1 because the schedule's day is Dec 1, wherever it is viewed.
const AUCKLAND_DEC_1 = "2026-11-30T11:00:00+00:00";

function expense(over: Partial<ExpenseWithSplits> = {}): ExpenseWithSplits {
  return {
    id: "e1",
    group_id: "g1",
    paid_by: "u1",
    amount: 100,
    description: "Rent",
    category: null,
    split_type: "equal",
    date: AUCKLAND_DEC_1,
    created_at: "2026-11-01T00:00:00Z",
    currency: "USD",
    exchange_rate: 1,
    base_amount: 100,
    schedule_id: null,
    occurrence_date: null,
    hand_edited: false,
    payer: { id: "u1", full_name: "Me", avatar_url: null, created_at: "" },
    expense_splits: [],
    ...over,
  };
}

function frequencies(map: Record<string, string>) {
  (useScheduleFrequencies as jest.Mock).mockReturnValue({ data: map });
}

beforeEach(() => {
  jest.clearAllMocks();
  frequencies({ s1: "monthly", s2: "biweekly" });
});

describe("ExpenseCard repeat chip", () => {
  const card = (e: ExpenseWithSplits, upcoming = false) => (
    <ExpenseCard
      expense={e}
      currentUserId="u1"
      onDelete={jest.fn()}
      upcoming={upcoming}
    />
  );

  it("shows 'Repeats monthly' on an occurrence of a monthly schedule", async () => {
    await renderWithPaper(
      card(expense({ schedule_id: "s1", occurrence_date: "2026-12-01" }))
    );

    expect(screen.getByText("Repeats monthly")).toBeTruthy();
  });

  it.each([
    ["daily", "Repeats daily"],
    ["weekly", "Repeats weekly"],
    ["biweekly", "Repeats every 2 weeks"],
    ["monthly", "Repeats monthly"],
    ["yearly", "Repeats yearly"],
  ])("words a %s schedule as '%s'", async (frequency, text) => {
    frequencies({ s1: frequency });
    await renderWithPaper(
      card(expense({ schedule_id: "s1", occurrence_date: "2026-12-01" }))
    );

    expect(screen.getByText(text)).toBeTruthy();
  });

  it("shows no chip on an ordinary expense", async () => {
    await renderWithPaper(card(expense()));

    expect(screen.queryByText(/^Repeats/)).toBeNull();
  });

  it("shows no chip until the schedule's frequency is known", async () => {
    frequencies({});
    await renderWithPaper(
      card(expense({ schedule_id: "s1", occurrence_date: "2026-12-01" }))
    );

    expect(screen.queryByText(/^Repeats/)).toBeNull();
  });

  it("sits next to the Upcoming tag", async () => {
    await renderWithPaper(
      card(expense({ schedule_id: "s2", occurrence_date: "2026-12-01" }), true)
    );

    expect(screen.getByText("Upcoming")).toBeTruthy();
    expect(screen.getByText("Repeats every 2 weeks")).toBeTruthy();
  });

  it("renders the schedule's own date, not the instant converted to this device's zone", async () => {
    await renderWithPaper(
      card(expense({ schedule_id: "s1", occurrence_date: "2026-12-01" }))
    );

    expect(screen.getByText("Dec 1")).toBeTruthy();
    expect(screen.getByText("2026")).toBeTruthy();
  });

  it("renders a scheduled row's date from occurrence_date even when the instant is a different day in every zone", async () => {
    await renderWithPaper(
      card(
        expense({
          schedule_id: "s1",
          occurrence_date: "2026-12-01",
          date: "2026-11-27T12:00:00Z",
        })
      )
    );

    expect(screen.getByText("Dec 1")).toBeTruthy();
    expect(screen.queryByText("Nov 27")).toBeNull();
  });

  it("a hand-moved occurrence shows the day it was moved to, not occurrence_date", async () => {
    const date = new Date(2026, 10, 30, 9).toISOString();
    await renderWithPaper(
      card(
        expense({
          schedule_id: "s1",
          occurrence_date: "2026-11-11",
          hand_edited: true,
          date,
        })
      )
    );

    expect(screen.getByText("Nov 30")).toBeTruthy();
    expect(screen.queryByText("Nov 11")).toBeNull();
  });

  it("an unmoved occurrence keeps occurrence_date", async () => {
    const date = new Date(2026, 10, 30, 9).toISOString();
    await renderWithPaper(
      card(
        expense({
          schedule_id: "s1",
          occurrence_date: "2026-11-11",
          hand_edited: false,
          date,
        })
      )
    );

    expect(screen.getByText("Nov 11")).toBeTruthy();
  });

  it("still renders an ordinary row's date from its instant", async () => {
    const date = "2026-11-27T12:00:00Z";
    const expected = new Date(date).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    await renderWithPaper(card(expense({ date })));

    expect(screen.getByText(expected)).toBeTruthy();
  });
});

describe("activity feed rows", () => {
  const groupRow = (over: Partial<ActivityExpense> = {}): ActivityExpense => ({
    id: "e1",
    description: "Rent",
    amount: 100,
    currency: "USD",
    date: "2026-11-27T12:00:00Z",
    paid_by: "u1",
    group_id: "g1",
    payer: null,
    groups: { name: "Flat" },
    expense_splits: [],
    ...over,
  });
  const contactRow = (
    over: Partial<ActivityContactExpense> = {}
  ): ActivityContactExpense => ({
    id: "c1",
    description: "Gym",
    amount: 40,
    currency: "USD",
    date: "2026-11-27T12:00:00Z",
    paid_by: "u1",
    user_lo: "u1",
    user_hi: "u2",
    payer: null,
    user_lo_profile: null,
    user_hi_profile: null,
    expense_splits: [],
    ...over,
  });

  it("tags a group occurrence and shows its occurrence date", async () => {
    await renderWithPaper(
      <ActivityFeedItemCard
        item={{
          kind: "expense",
          id: "e1",
          ts: "x",
          payload: groupRow({ schedule_id: "s1", occurrence_date: "2026-12-01" }),
        }}
        currentUserId="u1"
      />
    );

    expect(screen.getByText("Repeats monthly")).toBeTruthy();
    expect(screen.getByText(formatDay(new Date(2026, 11, 1)))).toBeTruthy();
  });

  it("tags a contact occurrence and counts an upcoming one from its occurrence date", async () => {
    await renderWithPaper(
      <ActivityFeedItemCard
        item={{
          kind: "contact-expense",
          id: "c1",
          ts: "x",
          payload: contactRow({
            schedule_id: "s2",
            occurrence_date: "2026-12-01",
          }),
        }}
        currentUserId="u1"
        upcoming
      />
    );

    expect(screen.getByText("Upcoming")).toBeTruthy();
    expect(screen.getByText("Repeats every 2 weeks")).toBeTruthy();
    expect(screen.getByText("Counts from Dec 1, 2026")).toBeTruthy();
  });

  it("a hand-moved upcoming row counts from the day it was moved to", async () => {
    await renderWithPaper(
      <ActivityFeedItemCard
        item={{
          kind: "expense",
          id: "e1",
          ts: "x",
          payload: groupRow({
            schedule_id: "s1",
            occurrence_date: "2026-11-11",
            hand_edited: true,
            date: new Date(2026, 10, 30, 9).toISOString(),
          }),
        }}
        currentUserId="u1"
        upcoming
      />
    );

    expect(screen.getByText("Counts from Nov 30, 2026")).toBeTruthy();
    expect(screen.queryByText(/Nov 11/)).toBeNull();
  });

  it("a hand-moved contact row shows the moved day", async () => {
    await renderWithPaper(
      <ActivityFeedItemCard
        item={{
          kind: "contact-expense",
          id: "c1",
          ts: "x",
          payload: contactRow({
            schedule_id: "s2",
            occurrence_date: "2026-11-11",
            hand_edited: true,
            date: new Date(2026, 10, 30, 9).toISOString(),
          }),
        }}
        currentUserId="u1"
      />
    );

    expect(screen.getByText("Nov 30, 2026")).toBeTruthy();
    expect(screen.queryByText("Nov 11, 2026")).toBeNull();
  });

  it("shows no chip and the instant's day on an ordinary row", async () => {
    await renderWithPaper(
      <ActivityFeedItemCard
        item={{ kind: "expense", id: "e1", ts: "x", payload: groupRow() }}
        currentUserId="u1"
      />
    );

    expect(screen.queryByText(/^Repeats/)).toBeNull();
    expect(
      screen.getByText(formatDay(new Date("2026-11-27T12:00:00Z")))
    ).toBeTruthy();
  });
});
