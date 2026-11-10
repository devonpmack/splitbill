import {
  deviceTimeZone,
  formatCalendarDay,
  formatDay,
  isRolledOverMDY,
  isUpcoming,
  parseCalendarDate,
  rowDay,
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

describe("rowDay", () => {
  const instant = new Date(2026, 10, 30, 9).toISOString();

  it("is an ordinary row's instant, in the viewer's zone", () => {
    expect(rowDay(instant)).toEqual(new Date(instant));
    expect(rowDay(instant, null, false)).toEqual(new Date(instant));
  });

  it("is a scheduled row's own calendar day", () => {
    expect(rowDay(instant, "2026-11-11", false)).toEqual(new Date(2026, 10, 11));
  });

  it("is the instant once a member has moved the occurrence", () => {
    expect(rowDay(instant, "2026-11-11", true)).toEqual(new Date(instant));
  });
});
