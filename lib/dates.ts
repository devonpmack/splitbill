function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Local midnight of `date`'s calendar day, e.g. "2026-11-12T00:00:00-05:00".
// The offset is the one in force at that midnight, so a day across a DST
// change still starts at its own local midnight.
export function startOfLocalDayISO(date: Date): string {
  const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const offset = -midnight.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${midnight.getFullYear()}-${pad(midnight.getMonth() + 1)}-${pad(midnight.getDate())}` +
    `T00:00:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
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
