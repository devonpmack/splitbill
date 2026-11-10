import { formatCalendarDay, toLocalDateString } from "./dates";
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

// The date at the schedule's cursor (the next occurrence to be created), or
// null when the schedule is stopped or has run out. Occurrences up to 48 hours
// ahead are created early, so the cursor can be a step past the soonest
// pending row, which the Upcoming list shows.
export function nextOccurrence(schedule: RecurringSchedule): string | null {
  if (schedule.stopped_at) return null;
  if (schedule.max_count !== null && schedule.next_index >= schedule.max_count) {
    return null;
  }
  const next = occurrenceDate(
    schedule.start_date,
    schedule.frequency,
    schedule.next_index
  );
  if (schedule.end_date !== null && next > schedule.end_date) return null;
  return next;
}

export function endSummary(schedule: RecurringSchedule): string {
  const parts: string[] = [];
  if (schedule.end_date !== null) {
    parts.push(`Until ${formatCalendarDay(schedule.end_date)}`);
  }
  if (schedule.max_count !== null) {
    parts.push(`${Math.max(schedule.max_count - schedule.next_index, 0)} left`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Never ends";
}

// The "After N times" field: a whole number of at least 1, else null.
export function parseRepeatCount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return count >= 1 ? count : null;
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
      ? { ok: false, error: "Number of repeats must be greater than zero" }
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
