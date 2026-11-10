import {
  deviceTimeZone,
  formatCalendarDay,
  formatDay,
  isRolledOverMDY,
  isUpcoming,
  parseCalendarDate,
  calendarDayIn,
  rowDay,
  startOfLocalDayInstant,
  pickedDateParam,
  startOfLocalDayISO,
  toLocalDateString,
} from "@/lib/dates";

// Expected strings are built from local Date parts, so these pass in any TZ.
function pad(n: number): string {
  return String(n).padStart(2, "0");
}

describe("startOfLocalDayISO", () => {
  it("returns local midnight of the given day with the local offset", () => {
    const afternoon = new Date(2026, 10, 12, 15, 42, 7, 123);
    const iso = startOfLocalDayISO(afternoon);

    expect(iso).toMatch(/^2026-11-12T00:00:00[+-]\d{2}:\d{2}$/);
    expect(new Date(iso).getTime()).toBe(new Date(2026, 10, 12).getTime());
  });

  it("uses the offset in force at that midnight, not today's", () => {
    const july = new Date(2026, 6, 1, 12);
    const iso = startOfLocalDayISO(july);
    const offset = -new Date(2026, 6, 1).getTimezoneOffset();
    const sign = offset >= 0 ? "+" : "-";
    const abs = Math.abs(offset);

    expect(iso).toBe(
      `2026-07-01T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    );
  });

  it("does not mutate its argument", () => {
    const day = new Date(2026, 10, 12, 15, 42);
    startOfLocalDayISO(day);
    expect(day.getHours()).toBe(15);
  });
});

describe("isUpcoming", () => {
  const now = new Date(2026, 10, 9, 15, 0);

  it("is true only strictly after now", () => {
    expect(isUpcoming(new Date(2026, 10, 9, 15, 0, 1).toISOString(), now)).toBe(true);
    expect(isUpcoming(now.toISOString(), now)).toBe(false);
    expect(isUpcoming(new Date(2026, 10, 9, 14, 59).toISOString(), now)).toBe(false);
  });

  it("treats tomorrow's local midnight as upcoming and today's as not", () => {
    expect(isUpcoming(startOfLocalDayISO(new Date(2026, 10, 10)), now)).toBe(true);
    expect(isUpcoming(startOfLocalDayISO(new Date(2026, 10, 9)), now)).toBe(false);
  });
});

describe("formatDay", () => {
  it("formats a Date or an ISO string as a short calendar day", () => {
    const day = new Date(2026, 10, 12, 18, 30);
    expect(formatDay(day)).toBe("Nov 12, 2026");
    expect(formatDay(day.toISOString())).toBe("Nov 12, 2026");
  });
});

describe("pickedDateParam", () => {
  const baseline = new Date(2026, 10, 9, 15, 30);

  it("sends nothing when no day was picked", () => {
    expect(pickedDateParam(undefined, baseline)).toBeUndefined();
  });

  it("sends nothing when the picked day is the baseline's day", () => {
    expect(pickedDateParam(new Date(2026, 10, 9), baseline)).toBeUndefined();
    expect(pickedDateParam(new Date(2026, 10, 9, 23, 59), baseline)).toBeUndefined();
  });

  it("sends the start of the picked local day when it differs", () => {
    expect(pickedDateParam(new Date(2026, 10, 12, 8), baseline)).toBe(
      startOfLocalDayISO(new Date(2026, 10, 12))
    );
    expect(pickedDateParam(new Date(2026, 10, 1), baseline)).toBe(
      startOfLocalDayISO(new Date(2026, 10, 1))
    );
  });
});

describe("isRolledOverMDY", () => {
  it("flags a typed day the Date constructor rolled over", () => {
    expect(isRolledOverMDY("02/30/2026", new Date(2026, 1, 30))).toBe(true);
    expect(isRolledOverMDY("13/45/2026", new Date(2026, 12, 45))).toBe(true);
    expect(isRolledOverMDY("02302026", new Date(2026, 1, 30))).toBe(true);
  });

  it("accepts real days, padded or not", () => {
    expect(isRolledOverMDY("02/29/2028", new Date(2028, 1, 29))).toBe(false);
    expect(isRolledOverMDY("2/3/2026", new Date(2026, 1, 3))).toBe(false);
  });

  it("does not judge text that is not a complete day", () => {
    expect(isRolledOverMDY("02/30/202", new Date(2026, 2, 5))).toBe(false);
    expect(isRolledOverMDY("", new Date(2026, 2, 5))).toBe(false);
  });
});

describe("toLocalDateString", () => {
  it("writes the local calendar day as YYYY-MM-DD, never an instant", () => {
    expect(toLocalDateString(new Date(2026, 10, 9, 23, 59))).toBe("2026-11-09");
    expect(toLocalDateString(new Date(2026, 0, 5, 0, 0))).toBe("2026-01-05");
    expect(toLocalDateString(new Date(2028, 1, 29, 12))).toBe("2028-02-29");
  });
});

describe("parseCalendarDate", () => {
  it("is local midnight of that day, whatever the zone", () => {
    const parsed = parseCalendarDate("2026-12-01");
    expect([parsed.getFullYear(), parsed.getMonth(), parsed.getDate()]).toEqual(
      [2026, 11, 1]
    );
    expect(parsed.getHours()).toBe(0);
  });
});

describe("formatCalendarDay", () => {
  it("formats a plain calendar date as the same day it names", () => {
    expect(formatCalendarDay("2026-12-01")).toBe(
      formatDay(new Date(2026, 11, 1))
    );
  });
});

describe("deviceTimeZone", () => {
  it("is the IANA name the runtime reports", () => {
    expect(deviceTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(deviceTimeZone()).toMatch(/^[A-Za-z_]+(\/[A-Za-z_+\-0-9]+)*$/);
  });
});

describe("startOfLocalDayInstant", () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it.each([
    ["America/Toronto", "2026-11-09", "2026-11-09T05:00:00.000Z"],
    ["America/Toronto", "2026-03-08", "2026-03-08T05:00:00.000Z"],
    ["America/Toronto", "2026-03-09", "2026-03-09T04:00:00.000Z"],
    ["America/Toronto", "2026-11-01", "2026-11-01T04:00:00.000Z"],
    ["Pacific/Auckland", "2026-12-01", "2026-11-30T11:00:00.000Z"],
    ["Pacific/Auckland", "2026-09-27", "2026-09-26T12:00:00.000Z"],
    ["UTC", "2026-12-01", "2026-12-01T00:00:00.000Z"],
    ["Pacific/Kiritimati", "2026-11-09", "2026-11-08T10:00:00.000Z"],
    ["Pacific/Pago_Pago", "2026-11-09", "2026-11-09T11:00:00.000Z"],
  ])("%s %s starts at %s", (tz, day, expected) => {
    expect(iso(startOfLocalDayInstant(day, tz))).toBe(expected);
  });

  it("is the first instant when midnight does not exist (Havana spring forward, 01:00)", () => {
    expect(iso(startOfLocalDayInstant("2026-03-08", "America/Havana"))).toBe(
      "2026-03-08T05:00:00.000Z"
    );
    expect(iso(startOfLocalDayInstant("2026-03-09", "America/Havana"))).toBe(
      "2026-03-09T04:00:00.000Z"
    );
  });

  it("is the first of two 00:00s when the clocks fall back at 01:00 (Havana)", () => {
    expect(iso(startOfLocalDayInstant("2026-11-01", "America/Havana"))).toBe(
      "2026-11-01T04:00:00.000Z"
    );
  });

  it.each([
    ["Asia/Beirut", "2026-03-29", "2026-03-28T22:00:00.000Z"],
    ["Africa/Cairo", "2026-04-24", "2026-04-23T22:00:00.000Z"],
    ["America/Santiago", "2026-09-06", "2026-09-06T04:00:00.000Z"],
  ])("is the first instant when %s skips midnight on %s", (tz, day, expected) => {
    expect(iso(startOfLocalDayInstant(day, tz))).toBe(expected);
  });

  it("is the instant whose own day is the given day and the minute before is the day before", () => {
    for (const tz of ["America/Toronto", "Pacific/Auckland", "America/Havana", "UTC"]) {
      for (const day of ["2026-03-08", "2026-03-29", "2026-09-27", "2026-11-01", "2026-12-01"]) {
        const ms = startOfLocalDayInstant(day, tz);
        expect(calendarDayIn(new Date(ms), tz)).toBe(day);
        expect(calendarDayIn(new Date(ms - 60_000), tz) < day).toBe(true);
      }
    }
  });
});

describe("calendarDayIn", () => {
  it("is the calendar day of an instant in a zone, not the device's", () => {
    const instant = new Date("2026-11-09T20:00:00Z");
    expect(calendarDayIn(instant, "America/Toronto")).toBe("2026-11-09");
    expect(calendarDayIn(instant, "Pacific/Auckland")).toBe("2026-11-10");
    expect(calendarDayIn(instant, "Pacific/Pago_Pago")).toBe("2026-11-09");
    expect(calendarDayIn(instant, "Pacific/Kiritimati")).toBe("2026-11-10");
  });
});

describe("rowDay", () => {
  const instant = new Date(2026, 10, 30, 9).toISOString();
  const AKL_DEC_1 = "2026-11-30T11:00:00.000Z";

  it("is an ordinary row's instant, in the viewer's zone", () => {
    expect(rowDay(instant)).toEqual(new Date(instant));
    expect(rowDay(instant, null, false)).toEqual(new Date(instant));
  });

  it("is a scheduled row's own calendar day", () => {
    expect(rowDay(instant, "2026-11-11", false)).toEqual(new Date(2026, 10, 11));
  });

  it("is the instant when an edited row's schedule zone is not known", () => {
    expect(rowDay(instant, "2026-11-11", true)).toEqual(new Date(instant));
  });

  it("is occurrence_date for an edited row that is still at its original instant", () => {
    expect(rowDay(AKL_DEC_1, "2026-12-01", true, "Pacific/Auckland")).toEqual(
      new Date(2026, 11, 1)
    );
  });

  it("is the instant for an edited row that was moved off its original instant", () => {
    const moved = "2026-12-05T05:00:00.000Z";
    expect(rowDay(moved, "2026-12-01", true, "Pacific/Auckland")).toEqual(
      new Date(moved)
    );
  });

  it("an unedited row is never judged moved, whatever its instant", () => {
    expect(rowDay("2026-12-05T05:00:00.000Z", "2026-12-01", false, "Pacific/Auckland")).toEqual(
      new Date(2026, 11, 1)
    );
  });
});
