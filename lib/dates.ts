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
