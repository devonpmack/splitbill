import { useEffect } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { useAuth } from "./auth";
import { invalidateRecurringCreated } from "./queries/invalidate";

// Same threshold as the foreground refetch: a shorter absence is a
// notification pulldown or a quick app switch.
const MIN_BACKGROUND_MS = 30_000;
// Each call row-locks every active schedule the user belongs to, so calls are
// spaced out however often the app comes back.
const MIN_INTERVAL_MS = 60_000;

// Best-effort fallback for the server's own scheduler: asks the server to
// create any repeats that are due, when the app opens and when it returns
// after at least 30 s in the background (never more than once a minute).
// Only the "background" state starts the clock: iOS reports "inactive" for
// blips such as the notification shade or Face ID. A failure is ignored (the
// next return tries again), and nothing is refetched unless rows were created.
export function useMaterialiseOnForeground() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;

    let running = false;
    let lastCallAt = -Infinity;
    const catchUp = async () => {
      if (running) return;
      running = true;
      lastCallAt = Date.now();
      try {
        const { data, error } = await supabase.rpc("materialise_my_recurring");
        if (!error && typeof data === "number" && data > 0) {
          invalidateRecurringCreated(queryClient);
        }
      } catch {
        // Offline or the project is unreachable: nothing to tell the user.
      } finally {
        running = false;
      }
    };

    catchUp();
    let backgroundedAt: number | null = null;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        backgroundedAt ??= Date.now();
      } else if (state === "active") {
        const now = Date.now();
        if (
          backgroundedAt !== null &&
          now - backgroundedAt >= MIN_BACKGROUND_MS &&
          now - lastCallAt >= MIN_INTERVAL_MS
        ) {
          catchUp();
        }
        backgroundedAt = null;
      }
    });
    return () => subscription.remove();
  }, [userId, queryClient]);
}
