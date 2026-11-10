import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "../supabase";
import type {
  ContactGroupBreakdown,
  ContactWithBalance,
} from "../types";
import { useAuth } from "../auth";
import { canConvert, convert, sumConverted } from "../currency";
import { useDisplayCurrency } from "../display-currency";
import { useExchangeRates } from "../exchange-rates";
import { invalidateContactPairQueries } from "./invalidate";



interface ContactBalanceContextRow {
  contact_user_id: string;
  full_name: string;
  avatar_url: string | null;
  currency: string;
  balance: number;
  is_accepted: boolean;
  deleted_at: string | null;
}

export function useContacts() {
  const { user } = useAuth();
  const { currency: displayCurrency } = useDisplayCurrency();
  const { data: rates } = useExchangeRates();

  const query = useQuery({
    queryKey: ["contacts", user?.id],
    queryFn: async (): Promise<ContactBalanceContextRow[]> => {
      const { data, error } = await supabase.rpc(
        "get_contacts_with_combined_balances"
      );
      if (error) throw error;
      return (data ?? []).map((row) => ({
        contact_user_id: row.contact_user_id,
        full_name: row.full_name,
        avatar_url: row.avatar_url,
        currency: row.currency,
        balance: Number(row.balance),
        is_accepted: row.is_accepted,
        deleted_at: row.contact_deleted_at ?? null,
      }));
    },
    enabled: !!user,
  });

  // Each contact has one row per currency context (1-on-1 ledger + each shared
  // group). Convert every piece to the display currency, then sum per contact.
  const contacts = useMemo<ContactWithBalance[]>(() => {
    const byContact = new Map<string, ContactWithBalance>();
    for (const row of query.data ?? []) {
      const existing = byContact.get(row.contact_user_id);
      const convertible = canConvert(row.currency, displayCurrency, rates);
      const converted = convertible
        ? convert(row.balance, row.currency, displayCurrency, rates)
        : null;
      if (existing) {
        existing.balance =
          existing.balance === null || converted === null
            ? null
            : existing.balance + converted;
      } else {
        byContact.set(row.contact_user_id, {
          contact_user_id: row.contact_user_id,
          full_name: row.full_name,
          avatar_url: row.avatar_url,
          balance: converted,
          is_accepted: row.is_accepted,
          deleted_at: row.deleted_at,
        });
      }
    }
    return Array.from(byContact.values()).map((c) => ({
      ...c,
      balance: c.balance === null ? null : Math.round(c.balance * 100) / 100,
    }));
  }, [query.data, rates, displayCurrency]);

  return { ...query, data: query.data ? contacts : undefined };
}

export function useContactBalance(contactUserId: string) {
  const { user } = useAuth();
  const { currency: displayCurrency } = useDisplayCurrency();
  const { data: rates } = useExchangeRates();

  const query = useQuery({
    queryKey: ["contact-balance", user?.id, contactUserId],
    queryFn: async (): Promise<{ currency: string; balance: number }[]> => {
      const { data, error } = await supabase.rpc(
        "get_contact_balance_contexts",
        {
          p_contact_user_id: contactUserId,
        }
      );
      if (error) throw error;
      return (data ?? []).map((row) => ({
        currency: row.currency,
        balance: Number(row.balance),
      }));
    },
    enabled: !!user && !!contactUserId,
  });

  // Combined balance: convert each per-currency context into the display
  // currency and sum.
  const balance = useMemo(
    () => sumConverted(query.data ?? [], displayCurrency, rates),
    [query.data, rates, displayCurrency]
  );

  return { ...query, data: query.data ? (balance ?? undefined) : undefined };
}

export function useContactPairBalance(contactUserId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["contact-pair-balance", user?.id, contactUserId],
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc("get_contact_balance", {
        p_contact_user_id: contactUserId,
      });
      if (error) throw error;
      return Number(data ?? 0);
    },
    enabled: !!user && !!contactUserId,
  });
}

export function useContactGroupBreakdown(contactUserId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["contact-group-breakdown", user?.id, contactUserId],
    queryFn: async (): Promise<ContactGroupBreakdown[]> => {
      const { data, error } = await supabase.rpc(
        "get_contact_group_breakdown",
        {
          p_contact_user_id: contactUserId,
        }
      );
      if (error) throw error;
      return (data ?? []).map((row) => ({
        group_id: row.group_id,
        group_name: row.group_name,
        balance: Number(row.balance),
        currency: row.currency,
      }));
    },
    enabled: !!user && !!contactUserId,
  });
}


















export function useContactCurrency(contactUserId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["contact-currency", user?.id, contactUserId],
    queryFn: async (): Promise<string> => {
      const { data, error } = await supabase.rpc("get_contact_currency", {
        p_contact_user_id: contactUserId,
      });
      if (error) throw error;
      return (data as string) ?? "USD";
    },
    enabled: !!user && !!contactUserId,
  });
}

export function useSetContactCurrency() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async ({
      contactUserId,
      currency,
    }: {
      contactUserId: string;
      currency: string;
    }) => {
      const { data, error } = await supabase.rpc("set_contact_currency", {
        p_contact_user_id: contactUserId,
        p_currency: currency,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["contact-currency", user?.id, variables.contactUserId],
      });
      invalidateContactPairQueries(
        queryClient,
        user?.id,
        variables.contactUserId
      );
    },
  });
}
