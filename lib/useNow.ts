import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { nextUpcomingAt } from "./upcoming";

// setTimeout stores its delay in 32 bits; longer delays fire immediately.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// The timer fires this long after a date, so a refetch made when it fires sees
// a row the server counts from that date even with a little clock skew.
const SLACK_MS = 2000;

// The time at this render, so rows classed against it are never judged by a
// stale clock (a row created after the screen has been open a while is already
// counting, not upcoming). The state only forces a re-render: when the soonest
// date in `dates` has passed (a row moves from Upcoming to the main list
// without a refresh) and when the app returns to the foreground (timers do not
// run while it is suspended). `onElapsed` runs when a date has passed so the
// caller can refetch what the server derives from it, such as balances.
export function useNow(dates: string[], onElapsed?: () => void): Date {
  const [tick, setTick] = useState(0);
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;
  const now = new Date();
  const next = nextUpcomingAt(dates, now);

  useEffect(() => {
    if (next === undefined) return;
    const target = next + SLACK_MS;
    const id = setTimeout(
      () => {
        if (Date.now() >= target) onElapsedRef.current?.();
        setTick((count) => count + 1);
      },
      Math.min(Math.max(target - Date.now(), 0), MAX_TIMEOUT_MS)
    );
    return () => clearTimeout(id);
  }, [next, tick]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setTick((count) => count + 1);
    });
    return () => subscription.remove();
  }, []);

  return now;
}
