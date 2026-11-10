function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const QUARTER_HOUR_MS = 15 * 60 * 1000;

// The first instant of `date`'s local calendar day with its offset, e.g.
// "2026-11-12T00:00:00-05:00". Where the clocks spring forward at midnight
// (Havana, Santiago, Cairo, Beirut) 00:00 does not exist that day and the day
// starts at 01:00, so the time is written from the instant, never assumed.
export function startOfLocalDayISO(date: Date): string {
  let start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  // An engine may resolve the missing midnight to the previous evening.
  while (!isSameLocalDay(start, date)) {
    start = new Date(start.getTime() + QUARTER_HOUR_MS);
  }
  const offset = -start.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}` +
    `T${pad(start.getHours())}:${pad(start.getMinutes())}:00` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// The local calendar day as "YYYY-MM-DD", the shape a `date` column takes.
// Never an instant: a day is sent as a day so no zone can move it.
export function toLocalDateString(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A plain "YYYY-MM-DD" calendar date as local midnight of that day, so every
// local formatter prints the day it names in any zone.
export function parseCalendarDate(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

// The calendar day ("YYYY-MM-DD") an instant falls on in the IANA zone `tz`.
export function calendarDayIn(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// Epoch ms of the first instant of the calendar day `day` ("YYYY-MM-DD") in
// the IANA zone `tz`: what the server stores as an occurrence's `date`. Where
// the clocks spring forward at midnight (Havana) that is 01:00, not 00:00.
export function startOfLocalDayInstant(day: string, tz: string): number {
  const [year, month, date] = day.split("-").map(Number);
  const utcMidnight = Date.UTC(year, month - 1, date);
  const offsetMinutes = (ms: number) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(ms));
    const n = (type: string) => Number(p.find((x) => x.type === type)?.value);
    const local = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
    return (local - Math.floor(ms / 1000) * 1000) / 60_000;
  };

  let guess = utcMidnight;
  for (let i = 0; i < 3; i++) {
    guess = utcMidnight - offsetMinutes(guess) * 60_000;
  }
  // Where midnight does not exist the offset search lands on the evening
  // before: step forward to the first instant that is on the day.
  for (let i = 0; i < 200 && calendarDayIn(new Date(guess), tz) < day; i++) {
    guess += QUARTER_HOUR_MS;
  }
  return guess;
}

// A member's edit freezes a scheduled row and may move its `date` (what
// balances count from) off the occurrence_date. It is moved when `date` is no
// longer the first instant of occurrence_date's day in the schedule's zone.
// Without the schedule's zone an edited row counts as moved.
export function isMovedOccurrence(
  date: string,
  occurrenceDate: string,
  handEdited?: boolean | null,
  scheduleTz?: string | null
): boolean {
  if (!handEdited) return false;
  return !(
    scheduleTz &&
    new Date(date).getTime() ===
      startOfLocalDayInstant(occurrenceDate, scheduleTz)
  );
}

// The day a row is shown under. A scheduled row that has not been moved
// carries its schedule's calendar date, which every viewer sees as is; any
// other row is dated by its instant in the viewer's zone.
export function rowDay(
  date: string,
  occurrenceDate?: string | null,
  handEdited?: boolean | null,
  scheduleTz?: string | null
): Date {
  return occurrenceDate &&
    !isMovedOccurrence(date, occurrenceDate, handEdited, scheduleTz)
    ? parseCalendarDate(occurrenceDate)
    : new Date(date);
}

export function formatCalendarDay(day: string): string {
  return formatDay(parseCalendarDate(day));
}

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

// Display only: the server decides what counts toward balances.
export function isUpcoming(dateISO: string, now: Date = new Date()): boolean {
  return new Date(dateISO).getTime() > now.getTime();
}

export function formatDay(date: Date | string): string {
  return new Date(date).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// The `date` a form sends. Undefined when the picked day is the baseline's day
// (today on create, the stored date on edit): the server then defaults to now()
// on create and keeps the stored timestamp, time of day included, on edit.
export function pickedDateParam(
  picked: Date | undefined,
  baseline: Date
): string | undefined {
  if (!picked || isSameLocalDay(picked, baseline)) return undefined;
  return startOfLocalDayISO(picked);
}

// True when a typed MM/DD/YYYY day is not the day `parsed` landed on, i.e.
// the Date constructor rolled an impossible day over (02/30 -> 03/02,
// month 13 -> next year). Text that is not a complete day is not judged.
export function isRolledOverMDY(text: string, parsed: Date): boolean {
  const groups = text.match(/\d+/g) ?? [];
  const parts =
    groups.length === 1 && groups[0].length === 8
      ? [groups[0].slice(0, 2), groups[0].slice(2, 4), groups[0].slice(4)]
      : groups;
  if (parts.length !== 3 || parts[2].length !== 4) return false;
  const [month, day, year] = parts.map(Number);
  return (
    month !== parsed.getMonth() + 1 ||
    day !== parsed.getDate() ||
    year !== parsed.getFullYear()
  );
}
