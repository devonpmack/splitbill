import { useEffect } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

// Away for less than this and the cache is as good as it was (a notification
// pulldown or a quick app switch).
const MIN_BACKGROUND_MS = 30_000;

// A balance changes when a future-dated row's date arrives, which writes
// nothing and so sends no realtime event; and the cache is five minutes stale
// by default. Refetching when the app returns after a real time in the
// background keeps what is shown correct after a long time away. Only the
// "background" state starts the clock: iOS reports "inactive" for blips such as
// the notification shade, which must not refetch everything.
export function useRefetchOnForeground() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let backgroundedAt: number | null = null;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        backgroundedAt ??= Date.now();
      } else if (state === "active") {
        if (
          backgroundedAt !== null &&
          Date.now() - backgroundedAt >= MIN_BACKGROUND_MS
        ) {
          queryClient.invalidateQueries();
        }
        backgroundedAt = null;
      }
    });
    return () => subscription.remove();
  }, [queryClient]);
}
