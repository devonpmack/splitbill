import {
  endSummary,
  frequencyLabel,
  nextOccurrence,
  occurrenceDate,
  repeatsPhrase,
  stopReasonLabel,
} from "@/lib/recurrence";
import type { RecurringSchedule } from "@/lib/types";

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
  amount: 100,
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

describe("occurrenceDate", () => {
  it("steps days, weeks and fortnights from the start", () => {
    expect(occurrenceDate("2026-12-30", "daily", 3)).toBe("2027-01-02");
    expect(occurrenceDate("2026-12-30", "weekly", 2)).toBe("2027-01-13");
    expect(occurrenceDate("2026-12-30", "biweekly", 2)).toBe("2027-01-27");
  });

  it("returns the start date for occurrence 0", () => {
    expect(occurrenceDate("2026-01-31", "monthly", 0)).toBe("2026-01-31");
  });

  it("clamps monthly to the month's last day, computed from the start, not chained", () => {
    expect(occurrenceDate("2026-01-31", "monthly", 1)).toBe("2026-02-28");
    expect(occurrenceDate("2026-01-31", "monthly", 2)).toBe("2026-03-31");
    expect(occurrenceDate("2026-01-31", "monthly", 3)).toBe("2026-04-30");
    expect(occurrenceDate("2026-01-31", "monthly", 13)).toBe("2027-02-28");
  });

  it("uses Feb 29 in a leap year", () => {
    expect(occurrenceDate("2027-12-31", "monthly", 2)).toBe("2028-02-29");
    expect(occurrenceDate("2028-01-29", "monthly", 1)).toBe("2028-02-29");
    expect(occurrenceDate("2028-01-30", "monthly", 1)).toBe("2028-02-29");
  });

  it("clamps a yearly Feb 29 to Feb 28 and returns to Feb 29 in the next leap year", () => {
    expect(occurrenceDate("2028-02-29", "yearly", 1)).toBe("2029-02-28");
    expect(occurrenceDate("2028-02-29", "yearly", 4)).toBe("2032-02-29");
  });

  it("rolls the year over for monthly steps", () => {
    expect(occurrenceDate("2026-11-15", "monthly", 3)).toBe("2027-02-15");
  });
});

describe("nextOccurrence", () => {
  it("is the date at the cursor", () => {
    expect(nextOccurrence(schedule({ next_index: 1 }))).toBe("2026-02-28");
    expect(nextOccurrence(schedule({ next_index: 2 }))).toBe("2026-03-31");
  });

  it("is null once max_count occurrences have been made or skipped", () => {
    expect(nextOccurrence(schedule({ max_count: 3, next_index: 3 }))).toBeNull();
    expect(nextOccurrence(schedule({ max_count: 3, next_index: 2 }))).toBe(
      "2026-03-31"
    );
  });

  it("is null when the next date is after end_date, and on it when equal", () => {
    expect(
      nextOccurrence(schedule({ end_date: "2026-03-30", next_index: 2 }))
    ).toBeNull();
    expect(
      nextOccurrence(schedule({ end_date: "2026-03-31", next_index: 2 }))
    ).toBe("2026-03-31");
  });

  it("is null for a stopped schedule", () => {
    expect(
      nextOccurrence(schedule({ stopped_at: "2026-02-01T00:00:00Z" }))
    ).toBeNull();
  });
});

describe("labels", () => {
  it("names each frequency for the form and the list", () => {
    expect(frequencyLabel("daily")).toBe("Daily");
    expect(frequencyLabel("weekly")).toBe("Weekly");
    expect(frequencyLabel("biweekly")).toBe("Every 2 weeks");
    expect(frequencyLabel("monthly")).toBe("Monthly");
    expect(frequencyLabel("yearly")).toBe("Yearly");
  });

  it("completes 'Repeats ...' for the chip", () => {
    expect(repeatsPhrase("daily")).toBe("daily");
    expect(repeatsPhrase("weekly")).toBe("weekly");
    expect(repeatsPhrase("biweekly")).toBe("every 2 weeks");
    expect(repeatsPhrase("monthly")).toBe("monthly");
    expect(repeatsPhrase("yearly")).toBe("yearly");
  });

  it("explains stop reasons in plain words", () => {
    expect(stopReasonLabel("completed")).toBe("Finished");
    expect(stopReasonLabel("member left")).toBe("A member left");
    expect(stopReasonLabel("invalid")).toBe("Could not be created");
    expect(stopReasonLabel("stopped")).toBe("Stopped");
    expect(stopReasonLabel(null)).toBe("Stopped");
  });
});

describe("endSummary", () => {
  it("says never when there is no limit", () => {
    expect(endSummary(schedule())).toBe("Never ends");
  });

  it("shows the end date", () => {
    expect(endSummary(schedule({ end_date: "2026-12-31" }))).toBe(
      "Until Dec 31, 2026"
    );
  });

  it("counts what is left after the made and skipped ones", () => {
    expect(endSummary(schedule({ max_count: 12, next_index: 5 }))).toBe(
      "7 left"
    );
    expect(endSummary(schedule({ max_count: 1, next_index: 0 }))).toBe(
      "1 left"
    );
  });

  it("never goes below zero", () => {
    expect(endSummary(schedule({ max_count: 2, next_index: 4 }))).toBe(
      "0 left"
    );
  });
});
