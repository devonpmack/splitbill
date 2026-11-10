import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { nextUpcomingAt } from "./upcoming";

// setTimeout stores its delay in 32 bits; longer delays fire immediately.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

// The current time as state, advanced when the soonest date in `dates` arrives
// (so a row moves from Upcoming to the main list without a refresh) and when
// the app returns to the foreground (timers do not run while it is suspended).
// `onElapsed` runs when a date arrives so the caller can refetch what the
// server derives from it, such as balances.
export function useNow(dates: string[], onElapsed?: () => void): Date {
  const [now, setNow] = useState(() => new Date());
  const onElapsedRef = useRef(onElapsed);
  onElapsedRef.current = onElapsed;
  const next = nextUpcomingAt(dates, now);

  useEffect(() => {
    if (next === undefined) return;
    const id = setTimeout(
      () => {
        const current = new Date();
        if (current.getTime() >= next) onElapsedRef.current?.();
        setNow(current);
      },
      Math.min(Math.max(next - Date.now(), 0), MAX_TIMEOUT_MS)
    );
    return () => clearTimeout(id);
  }, [next, now]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setNow(new Date());
    });
    return () => subscription.remove();
  }, []);

  return now;
}
