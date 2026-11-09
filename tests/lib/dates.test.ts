import {
  formatDay,
  isUpcoming,
  pickedDateParam,
  startOfLocalDayISO,
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
