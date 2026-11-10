import { useEffect } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { useAuth } from "./auth";
import { invalidateRecurringCreated } from "./queries/invalidate";

// Best-effort fallback for the server's own scheduler: asks the server to
// create any repeats that are due, once when the app opens and once each time
// it returns to the foreground. A failure is ignored (the next foreground
// tries again), and nothing is refetched unless rows were really created.
export function useMaterialiseOnForeground() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;

    let running = false;
    const catchUp = async () => {
      if (running) return;
      running = true;
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
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && previous !== "active") catchUp();
      previous = state;
    });
    return () => subscription.remove();
  }, [userId, queryClient]);
}
