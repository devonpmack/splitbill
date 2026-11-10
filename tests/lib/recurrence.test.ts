import {
  buildRepeat,
  endSummary,
  frequencyLabel,
  hidesChip,
  nextOccurrenceFrom,
  lastOccurrenceDate,
  MAX_REPEAT_COUNT,
  occurrenceDate,
  parseRepeatCount,
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

describe("nextOccurrenceFrom", () => {
  // `now` is an instant; the schedule's own zone decides what day it is.
  const at = (iso: string) => new Date(iso);
  const TORONTO_NOON_NOV_9 = at("2026-11-09T17:00:00Z");

  it("is the first occurrence strictly after today in the schedule's zone", () => {
    const monthly = schedule({ start_date: "2026-01-31" });
    expect(nextOccurrenceFrom(monthly, at("2026-02-01T17:00:00Z"))).toEqual({
      index: 1,
      date: "2026-02-28",
    });
    // Today is an occurrence day: that one is already created, so Next is the one after.
    expect(nextOccurrenceFrom(monthly, at("2026-02-28T17:00:00Z"))).toEqual({
      index: 2,
      date: "2026-03-31",
    });
  });

  it("monthly 'After 3' starting today: next is one month on and 2 are left", () => {
    const counted = schedule({
      start_date: "2026-11-09",
      max_count: 3,
      next_index: 1,
    });
    const next = nextOccurrenceFrom(counted, TORONTO_NOON_NOV_9);
    expect(next).toEqual({ index: 1, date: "2026-12-09" });
    expect(endSummary(counted, next)).toBe("2 left");
  });

  it("daily: tomorrow, whatever the cursor says", () => {
    const daily = schedule({
      frequency: "daily",
      start_date: "2026-11-07",
      next_index: 5,
    });
    expect(nextOccurrenceFrom(daily, TORONTO_NOON_NOV_9)).toEqual({
      index: 3,
      date: "2026-11-10",
    });
  });

  it("is the start date itself before the series has started", () => {
    expect(
      nextOccurrenceFrom(
        schedule({ start_date: "2026-12-01", next_index: 0 }),
        TORONTO_NOON_NOV_9
      )
    ).toEqual({ index: 0, date: "2026-12-01" });
  });

  it("end date is inclusive", () => {
    const ending = schedule({
      frequency: "daily",
      start_date: "2026-11-01",
      end_date: "2026-11-10",
    });
    expect(nextOccurrenceFrom(ending, TORONTO_NOON_NOV_9)).toEqual({
      index: 9,
      date: "2026-11-10",
    });
    expect(
      nextOccurrenceFrom(ending, at("2026-11-10T17:00:00Z"))
    ).toBeNull();
  });

  it("is null once every counted occurrence is today or earlier", () => {
    const counted = schedule({ start_date: "2026-08-09", max_count: 4 });
    expect(nextOccurrenceFrom(counted, at("2026-10-09T17:00:00Z"))).toEqual({
      index: 3,
      date: "2026-11-09",
    });
    expect(nextOccurrenceFrom(counted, TORONTO_NOON_NOV_9)).toBeNull();
    expect(endSummary(counted, null)).toBe("0 left");
  });

  it("is null for a stopped schedule", () => {
    expect(
      nextOccurrenceFrom(
        schedule({ stopped_at: "2026-02-01T00:00:00Z" }),
        TORONTO_NOON_NOV_9
      )
    ).toBeNull();
  });

  describe("uses the schedule's own zone, not the device's", () => {
    // 2026-11-09 20:00Z: Nov 9 15:00 in Toronto, Nov 10 09:00 in Auckland.
    const now = at("2026-11-09T20:00:00Z");
    const daily = (tz: string) =>
      schedule({ frequency: "daily", start_date: "2026-11-01", tz });

    it("Toronto viewing an Auckland schedule: Auckland is already on Nov 10, so Next is Nov 11", () => {
      expect(nextOccurrenceFrom(daily("Pacific/Auckland"), now)?.date).toBe(
        "2026-11-11"
      );
    });

    it("the same instant in a Toronto schedule: Next is Nov 10", () => {
      expect(nextOccurrenceFrom(daily("America/Toronto"), now)?.date).toBe(
        "2026-11-10"
      );
    });

    it("Kiritimati viewing a Pago_Pago schedule: Pago_Pago is a day behind, so Next is the day after its today", () => {
      // 2026-11-10 03:00Z: Nov 10 17:00 in Kiritimati (UTC+14), Nov 9 16:00 in Pago_Pago (UTC-11).
      const instant = at("2026-11-10T03:00:00Z");
      expect(nextOccurrenceFrom(daily("Pacific/Pago_Pago"), instant)?.date).toBe(
        "2026-11-10"
      );
      expect(nextOccurrenceFrom(daily("Pacific/Kiritimati"), instant)?.date).toBe(
        "2026-11-11"
      );
    });

    it("does not depend on TZ of the test process", () => {
      const before = process.env.TZ;
      const results = ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"].map(
        (viewer) => {
          process.env.TZ = viewer;
          return nextOccurrenceFrom(daily("Pacific/Auckland"), now)?.date;
        }
      );
      process.env.TZ = before;
      expect(new Set(results)).toEqual(new Set(["2026-11-11"]));
    });
  });
});

describe("hidesChip", () => {
  const summary = (over = {}) => ({
    frequency: "monthly" as const,
    tz: "UTC",
    stopped: true,
    stopReason: "stopped" as const,
    ...over,
  });

  it.each(["stopped", "member left", "invalid"] as const)(
    "hides the chip on an upcoming row of a schedule stopped for '%s'",
    (stopReason) => {
      expect(hidesChip(summary({ stopReason }), true)).toBe(true);
    }
  );

  it("keeps the chip on a past row of the same schedule", () => {
    expect(hidesChip(summary(), false)).toBe(false);
  });

  it("keeps the chip on every row of a completed schedule", () => {
    const completed = summary({ stopReason: "completed" });
    expect(hidesChip(completed, true)).toBe(false);
    expect(hidesChip(completed, false)).toBe(false);
  });

  it("keeps the chip on an active schedule", () => {
    const active = summary({ stopped: false, stopReason: null });
    expect(hidesChip(active, true)).toBe(false);
  });

  it("does not judge a schedule that has not loaded", () => {
    expect(hidesChip(undefined, true)).toBe(false);
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
    expect(endSummary(schedule(), { index: 3 })).toBe("Never ends");
  });

  it("shows the end date", () => {
    expect(endSummary(schedule({ end_date: "2026-12-31" }), { index: 3 })).toBe(
      "Until Dec 31, 2026"
    );
  });

  it("counts the next occurrence and every one after it as left", () => {
    expect(endSummary(schedule({ max_count: 12 }), { index: 5 })).toBe("7 left");
    expect(endSummary(schedule({ max_count: 1 }), { index: 0 })).toBe("1 left");
  });

  it("is 0 left when there is no next occurrence", () => {
    expect(endSummary(schedule({ max_count: 2 }), null)).toBe("0 left");
  });
});

describe("parseRepeatCount", () => {
  it.each([
    ["1", 1],
    [" 12 ", 12],
    ["1000", 1000],
  ])("accepts %p", (text, expected) => {
    expect(parseRepeatCount(text)).toBe(expected);
  });

  it.each([
    "0",
    "",
    "  ",
    "abc",
    "2.5",
    "-1",
    "1e3",
    "3x",
    "12abc",
    "1001",
    "99999999",
    "2147483648",
    "99999999999999999999999",
  ])("rejects %p", (text) => {
    expect(parseRepeatCount(text)).toBeNull();
  });

  it("caps the count at 1000", () => {
    expect(MAX_REPEAT_COUNT).toBe(1000);
  });
});

describe("lastOccurrenceDate", () => {
  it("is the date of the count-th occurrence", () => {
    expect(lastOccurrenceDate("2026-11-09", "monthly", 3)).toBe("2027-01-09");
    expect(lastOccurrenceDate("2026-11-09", "daily", 1)).toBe("2026-11-09");
  });

  it("is null for a count that is not valid, never throwing", () => {
    for (const count of [0, -1, 1001, 99_999_999, 2 ** 31, NaN, 1.5]) {
      expect(lastOccurrenceDate("2026-11-09", "monthly", count)).toBeNull();
    }
  });

  it("is null when the resulting date does not exist, never throwing", () => {
    expect(lastOccurrenceDate("not-a-date", "monthly", 3)).toBeNull();
  });
});

describe("buildRepeat", () => {
  const base = {
    frequency: "monthly" as const,
    startDay: new Date(2026, 10, 9, 15, 30),
    ends: "never" as const,
    endDay: null,
    count: "12",
    timeZone: "America/Toronto",
  };

  it("sends the start as a calendar day, never an instant", () => {
    expect(buildRepeat(base)).toEqual({
      ok: true,
      repeat: {
        frequency: "monthly",
        startDate: "2026-11-09",
        timeZone: "America/Toronto",
      },
    });
  });

  it("ignores the end fields while it never ends", () => {
    const result = buildRepeat({ ...base, endDay: new Date(2027, 0, 1) });
    expect(result).toEqual({
      ok: true,
      repeat: expect.not.objectContaining({ endDate: expect.anything() }),
    });
  });

  it("sends the end date as a calendar day", () => {
    expect(
      buildRepeat({ ...base, ends: "date", endDay: new Date(2027, 0, 15, 22) })
    ).toEqual({
      ok: true,
      repeat: expect.objectContaining({ endDate: "2027-01-15" }),
    });
  });

  it("refuses an end date that is not a day", () => {
    expect(buildRepeat({ ...base, ends: "date", endDay: null })).toEqual({
      ok: false,
      error: "Please enter a valid end date",
    });
  });

  it("sends the count, or refuses one that is not a whole number above zero", () => {
    expect(buildRepeat({ ...base, ends: "count", count: "6" })).toEqual({
      ok: true,
      repeat: expect.objectContaining({ maxCount: 6 }),
    });
    expect(buildRepeat({ ...base, ends: "count", count: "0" })).toEqual({
      ok: false,
      error: "Enter a number from 1 to 1000",
    });
  });
});
