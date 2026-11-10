import { calendarDayIn, formatCalendarDay, toLocalDateString } from "./dates";
import type {
  RecurringFrequency,
  RecurringSchedule,
  RecurringStopReason,
} from "./types";

export const FREQUENCIES: RecurringFrequency[] = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
  "yearly",
];

const FREQUENCY_LABELS: Record<RecurringFrequency, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  yearly: "Yearly",
};

const REPEATS_PHRASES: Record<RecurringFrequency, string> = {
  daily: "daily",
  weekly: "weekly",
  biweekly: "every 2 weeks",
  monthly: "monthly",
  yearly: "yearly",
};

const DAY_STEPS: Partial<Record<RecurringFrequency, number>> = {
  daily: 1,
  weekly: 7,
  biweekly: 14,
};

const STOP_REASON_LABELS: Record<RecurringStopReason, string> = {
  completed: "Finished",
  "member left": "A member left",
  invalid: "Could not be created",
  stopped: "Stopped",
};

export function frequencyLabel(frequency: RecurringFrequency): string {
  return FREQUENCY_LABELS[frequency];
}

// Completes "Repeats ..." on the chip.
export function repeatsPhrase(frequency: RecurringFrequency): string {
  return REPEATS_PHRASES[frequency];
}

export function stopReasonLabel(reason: RecurringStopReason | null): string {
  return reason ? STOP_REASON_LABELS[reason] : "Stopped";
}

function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function formatUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// The n-th occurrence of a schedule, a "YYYY-MM-DD" date. Mirrors the server:
// always start + n * step computed from the start, never chained from the
// previous date, so Jan 31 monthly goes Feb 28, Mar 31 (not Feb 28, Mar 28).
// A month step that lands past the month's end clamps to its last day.
export function occurrenceDate(
  startDate: string,
  frequency: RecurringFrequency,
  n: number
): string {
  const [year, month, day] = startDate.split("-").map(Number);
  const dayStep = DAY_STEPS[frequency];
  if (dayStep) {
    return formatUTC(new Date(Date.UTC(year, month - 1, day + n * dayStep)));
  }

  const months = n * (frequency === "yearly" ? 12 : 1);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const clamped = Math.min(
    day,
    lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth())
  );
  return formatUTC(
    new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), clamped))
  );
}

// The first occurrence strictly after today (in the schedule's own zone, at the
// instant `now`) that the schedule will still make, counted from the start
// date, or null when it is stopped or has run out. Today's occurrence has
// already been created, and the server's cursor is not used: occurrences up to
// 48 hours ahead are created early, so it can sit days past the real next one.
// An occurrence a member deleted (a skip) cannot be seen from here, so it can
// still be shown as the next one.
export function nextOccurrenceFrom(
  schedule: RecurringSchedule,
  now: Date
): { index: number; date: string } | null {
  if (schedule.stopped_at) return null;
  const today = calendarDayIn(now, schedule.tz);
  for (let index = 0; ; index++) {
    if (schedule.max_count !== null && index >= schedule.max_count) return null;
    const date = occurrenceDate(schedule.start_date, schedule.frequency, index);
    if (schedule.end_date !== null && date > schedule.end_date) return null;
    if (date > today) return { index, date };
  }
}

// What a row needs to know about its schedule.
export interface ScheduleSummary {
  frequency: RecurringFrequency;
  tz: string;
  stopped: boolean;
  stopReason: RecurringStopReason | null;
}

// An upcoming row left behind by a schedule that was stopped, lost a member or
// failed will never repeat, so it is not marked as repeating. Past rows keep
// their mark (they were part of the series) and so do those of a schedule that
// simply finished: the server flags it completed up to 48 hours before its
// last occurrence, while its rows are still upcoming.
export function hidesChip(
  schedule: ScheduleSummary | undefined,
  isUpcomingRow: boolean
): boolean {
  return (
    !!schedule &&
    isUpcomingRow &&
    schedule.stopped &&
    schedule.stopReason !== "completed"
  );
}

export function endSummary(
  schedule: RecurringSchedule,
  next: { index: number } | null
): string {
  const parts: string[] = [];
  if (schedule.end_date !== null) {
    parts.push(`Until ${formatCalendarDay(schedule.end_date)}`);
  }
  if (schedule.max_count !== null) {
    parts.push(`${next ? schedule.max_count - next.index : 0} left`);
  }
  return parts.length > 0 ? parts.join(" \u00b7 ") : "Never ends";
}

// A series is capped well below anything the server or a date can hold.
export const MAX_REPEAT_COUNT = 1000;
export const REPEAT_COUNT_ERROR = `Enter a number from 1 to ${MAX_REPEAT_COUNT}`;

function isValidRepeatCount(count: number): boolean {
  return Number.isInteger(count) && count >= 1 && count <= MAX_REPEAT_COUNT;
}

// The "After N times" field: a whole number from 1 to the cap, else null.
export function parseRepeatCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return isValidRepeatCount(count) ? count : null;
}

// The date of the last of `count` occurrences, or null when the count or the
// start is not valid. Never throws: it runs while the form renders.
export function lastOccurrenceDate(
  startDate: string,
  frequency: RecurringFrequency,
  count: number
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !isValidRepeatCount(count)) {
    return null;
  }
  return occurrenceDate(startDate, frequency, count - 1);
}

export type RepeatEnds = "never" | "date" | "count";

// How a new expense repeats, as the form hands it on.
export interface RepeatSubmission {
  frequency: RecurringFrequency;
  // The first occurrence's local calendar day, "YYYY-MM-DD".
  startDate: string;
  timeZone: string;
  endDate?: string;
  maxCount?: number;
}

export function buildRepeat(input: {
  frequency: RecurringFrequency;
  startDay: Date;
  ends: RepeatEnds;
  // Null when the typed end day is incomplete or invalid.
  endDay: Date | null;
  count: string;
  timeZone: string;
}): { ok: true; repeat: RepeatSubmission } | { ok: false; error: string } {
  const { frequency, startDay, ends, endDay, count, timeZone } = input;
  const base = {
    frequency,
    startDate: toLocalDateString(startDay),
    timeZone,
  };

  if (ends === "date") {
    return endDay
      ? { ok: true, repeat: { ...base, endDate: toLocalDateString(endDay) } }
      : { ok: false, error: "Please enter a valid end date" };
  }
  if (ends === "count") {
    const maxCount = parseRepeatCount(count);
    return maxCount === null
      ? { ok: false, error: REPEAT_COUNT_ERROR }
      : { ok: true, repeat: { ...base, maxCount } };
  }
  return { ok: true, repeat: base };
}

// Deleting one occurrence is a skip: the series goes on and the cursor has
// already moved past it, so it is not recreated.
const SKIP_OCCURRENCE_NOTE =
  "This only removes this one occurrence; the series continues. To stop the series, use Repeating.";

export function withSkipNote(message: string, isOccurrence: boolean): string {
  return isOccurrence ? `${message} ${SKIP_OCCURRENCE_NOTE}` : message;
}
