import { useEffect } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

// A balance changes when a future-dated row's date arrives, which writes
// nothing and so sends no realtime event; and the cache is five minutes stale
// by default. Refetching when the app comes back to the foreground keeps what
// is shown correct after a long time away.
export function useRefetchOnForeground() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previous !== "active") {
        queryClient.invalidateQueries();
      }
      previous = state;
    });
    return () => subscription.remove();
  }, [queryClient]);
}
