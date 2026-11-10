import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { nextUpcomingAt } from "./upcoming";

// setTimeout stores its delay in 32 bits; longer delays fire immediately.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// The refetch runs this long after a date, so a refetch made then sees a row
// the server counts from that date even with a little clock skew.
const SLACK_MS = 2000;

function delayUntil(target: number): number {
  return Math.min(Math.max(target - Date.now(), 0), MAX_TIMEOUT_MS);
}

// The time at this render, so rows classed against it are never judged by a
// stale clock (a row created after the screen has been open a while is already
// counting, not upcoming). State only forces a re-render, which two timers and
// the app returning to the foreground trigger:
// - at the soonest upcoming date, so the row moves to the main list then;
// - 2 s after each date that was upcoming when this hook first saw it, to call
//   `onElapsed` once so the caller can refetch what the server derives from the
//   date, such as balances. That date stays pending until the call, so a
//   re-render or foreground event inside the 2 s (or after a suspension) does
//   not lose it, and a date that was already past when it first appeared, or
//   whose row is gone, never triggers one.
export function useNow(dates: string[], onElapsed?: () => void): Date {
  const [tick, setTick] = useState(0);
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;
  const pendingRef = useRef(new Set<number>());
  const now = new Date();

  const present = new Set(dates.map((date) => new Date(date).getTime()));
  const pending = pendingRef.current;
  for (const time of pending) if (!present.has(time)) pending.delete(time);
  for (const time of present) if (time > now.getTime()) pending.add(time);

  const nextDisplay = nextUpcomingAt(dates, now);
  const nextRefetch = pending.size > 0 ? Math.min(...pending) : undefined;

  useEffect(() => {
    if (nextDisplay === undefined) return;
    const id = setTimeout(() => setTick((count) => count + 1), delayUntil(nextDisplay));
    return () => clearTimeout(id);
  }, [nextDisplay, tick]);

  useEffect(() => {
    if (nextRefetch === undefined) return;
    const target = nextRefetch + SLACK_MS;
    const id = setTimeout(() => {
      if (Date.now() >= target) {
        for (const time of pendingRef.current) {
          if (time + SLACK_MS <= Date.now()) pendingRef.current.delete(time);
        }
        onElapsedRef.current?.();
      }
      setTick((count) => count + 1);
    }, delayUntil(target));
    return () => clearTimeout(id);
  }, [nextRefetch, tick]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setTick((count) => count + 1);
    });
    return () => subscription.remove();
  }, []);

  return now;
}
