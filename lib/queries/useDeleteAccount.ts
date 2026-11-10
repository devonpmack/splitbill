import { useMutation, useQuery } from "@tanstack/react-query";
import { supabase } from "../supabase";
import { useAuth } from "../auth";
import { useGroups } from "./useGroups";
import { hasSignificantBalance } from "../balance-display";
import {
  DeletedButStillSignedInError,
  type OpenBalance,
} from "../delete-account";

// Deletes the signed-in user's account on the server (delete_my_account: no
// arguments, returns nothing, raises on failure), then signs this device out.
// AuthProvider clears the query cache when the signed-in user changes, and the
// tabs layout sends a signed-out user back to sign-in.
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("delete_my_account");
      if (error) throw new Error(error.message);

      // The account is gone. A local sign-out still asks the server to end the
      // session (ignoring 401, 403 and 404), so a network failure can leave
      // the session in place: say so instead of pretending it worked.
      try {
        const { error: signOutError } = await supabase.auth.signOut({
          scope: "local",
        });
        if (signOutError) throw signOutError;
      } catch {
        throw new DeletedButStillSignedInError();
      }
    },
  });
}

// My net balance in every group I am in, keeping the groups where it is not
// zero. Shown before deleting, so the person sees what they leave behind.
export function useMyOpenBalances() {
  const { user } = useAuth();
  const groupsQuery = useGroups();
  const { data: groups, isSuccess: groupsLoaded } = groupsQuery;
  const groupKey = (groups ?? []).map((g) => g.id).join(",");

  const query = useQuery({
    queryKey: ["delete-account-open-balances", user?.id, groupKey],
    queryFn: async (): Promise<OpenBalance[]> => {
      const rows = await Promise.all(
        (groups ?? []).map(async (group) => {
          const { data, error } = await supabase.rpc("get_group_balances", {
            p_group_id: group.id,
          });
          if (error) throw error;
          const mine = (data ?? []).find((r) => r.user_id === user!.id);
          return {
            groupId: group.id,
            groupName: group.name,
            currency: group.currency,
            balance: Number(mine?.balance ?? 0),
          };
        })
      );
      return rows.filter((r) => hasSignificantBalance(r.balance));
    },
    enabled: !!user && groupsLoaded,
  });

  // The balances wait for the group list, so the query alone is "not loading"
  // while it is disabled. Report the two together: an unread list is pending,
  // and a failed group list is an error rather than an endless wait.
  const isError = groupsQuery.isError || query.isError;
  return {
    data: query.data,
    isError,
    isPending: !isError && (groupsQuery.isPending || query.isPending),
    isSuccess: query.isSuccess,
  };
}
