import { isUpcoming } from "./dates";

// The recent and the upcoming read of one source each take their own reading of
// the clock, so a row dated between the two could be in neither. The upcoming
// read starts this far before its own now: the overlap is de-duplicated by id
// and the rows in it are classed by the client clock like any other.
export const UPCOMING_OVERLAP_MS = 60_000;

// Splits rows into future-dated ("upcoming", soonest first) and the rest
// (newest first). Display only: the server decides what counts toward balances.
export function partitionUpcoming<T>(
  rows: T[],
  getDate: (row: T) => string,
  now: Date
): { upcoming: T[]; past: T[] } {
  const upcoming: T[] = [];
  const past: T[] = [];
  for (const row of rows) {
    (isUpcoming(getDate(row), now) ? upcoming : past).push(row);
  }
  const time = (row: T) => new Date(getDate(row)).getTime();
  upcoming.sort((a, b) => time(a) - time(b));
  past.sort((a, b) => time(b) - time(a));
  return { upcoming, past };
}

// Epoch ms of the soonest date strictly after `now`, or undefined when none is.
export function nextUpcomingAt(dates: string[], now: Date): number | undefined {
  let next: number | undefined;
  for (const date of dates) {
    if (!isUpcoming(date, now)) continue;
    const time = new Date(date).getTime();
    if (next === undefined || time < next) next = time;
  }
  return next;
}
