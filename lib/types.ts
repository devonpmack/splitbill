export type SplitType = "equal" | "exact" | "percentage";

export type RecurringFrequency =
  | "daily"
  | "weekly"
  | "biweekly"
  | "monthly"
  | "yearly";

export type RecurringStopReason =
  | "completed"
  | "member left"
  | "invalid"
  | "stopped";

export interface RecurringScheduleSplit {
  userId: string;
  amount: number;
  baseAmount?: number;
}

export type { CurrencyCode } from "./currency";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string;
          avatar_url: string | null;
          created_at: string;
        };
        Insert: {
          id: string;
          full_name: string;
          avatar_url?: string | null;
        };
        Update: {
          full_name?: string;
          avatar_url?: string | null;
        };
        Relationships: [];
      };
      groups: {
        Row: {
          id: string;
          name: string;
          image_url: string | null;
          created_by: string;
          created_at: string;
          currency: string;
          simplify_debts: boolean;
        };
        Insert: {
          id?: string;
          name: string;
          image_url?: string | null;
          created_by: string;
          currency?: string;
          simplify_debts?: boolean;
        };
        Update: {
          name?: string;
          image_url?: string | null;
          currency?: string;
          simplify_debts?: boolean;
        };
        Relationships: [];
      };
      group_members: {
        Row: {
          id: string;
          group_id: string;
          user_id: string;
          joined_at: string;
        };
        Insert: {
          id?: string;
          group_id: string;
          user_id: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      expenses: {
        Row: {
          id: string;
          group_id: string;
          paid_by: string;
          amount: number;
          description: string;
          category: string | null;
          split_type: SplitType;
          date: string;
          created_at: string;
          currency: string;
          exchange_rate: number;
          base_amount: number;
          schedule_id: string | null;
          occurrence_date: string | null;
          hand_edited: boolean;
        };
        Insert: {
          id?: string;
          group_id: string;
          paid_by: string;
          amount: number;
          description: string;
          category?: string | null;
          split_type: SplitType;
          date?: string;
          currency?: string;
          exchange_rate?: number;
          base_amount?: number;
        };
        Update: {
          amount?: number;
          description?: string;
          category?: string | null;
          split_type?: SplitType;
          date?: string;
          currency?: string;
          exchange_rate?: number;
          base_amount?: number;
        };
        Relationships: [];
      };
      expense_splits: {
        Row: {
          id: string;
          expense_id: string;
          user_id: string;
          amount: number;
          base_amount: number;
        };
        Insert: {
          id?: string;
          expense_id: string;
          user_id: string;
          amount: number;
          base_amount?: number;
        };
        Update: {
          amount?: number;
          base_amount?: number;
        };
        Relationships: [];
      };
      payments: {
        Row: {
          id: string;
          group_id: string;
          paid_by: string;
          paid_to: string;
          amount: number;
          note: string | null;
          created_at: string;
          currency: string;
          exchange_rate: number;
          base_amount: number;
          date: string;
        };
        Insert: {
          id?: string;
          group_id: string;
          paid_by: string;
          paid_to: string;
          amount: number;
          note?: string | null;
          currency?: string;
          exchange_rate?: number;
          base_amount?: number;
          date?: string;
        };
        Update: {
          paid_by?: string;
          paid_to?: string;
          amount?: number;
          note?: string | null;
          currency?: string;
          exchange_rate?: number;
          base_amount?: number;
          date?: string;
        };
        Relationships: [];
      };
      contacts: {
        Row: {
          id: string;
          owner_id: string;
          contact_user_id: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          contact_user_id: string;
        };
        Update: Record<string, never>;
        Relationships: [];
      };
      contact_expenses: {
        Row: {
          id: string;
          paid_by: string;
          user_lo: string;
          user_hi: string;
          amount: number;
          description: string;
          category: string | null;
          split_type: SplitType;
          date: string;
          created_at: string;
          currency: string;
          exchange_rate: number;
          base_amount: number;
          schedule_id: string | null;
          occurrence_date: string | null;
          hand_edited: boolean;
        };
        Insert: {
          id?: string;
          paid_by: string;
          user_lo: string;
          user_hi: string;
          amount: number;
          description: string;
          category?: string | null;
          split_type: SplitType;
          date?: string;
          currency?: string;
          exchange_rate?: number;
          base_amount?: number;
        };
        Update: {
          amount?: number;
          description?: string;
          category?: string | null;
          split_type?: SplitType;
          date?: string;
          currency?: string;
          exchange_rate?: number;
          base_amount?: number;
        };
        Relationships: [];
      };
      contact_expense_splits: {
        Row: {
          id: string;
          expense_id: string;
          user_id: string;
          amount: number;
          base_amount: number;
        };
        Insert: {
          id?: string;
          expense_id: string;
          user_id: string;
          amount: number;
          base_amount?: number;
        };
        Update: {
          amount?: number;
          base_amount?: number;
        };
        Relationships: [];
      };
      contact_payments: {
        Row: {
          id: string;
          paid_by: string;
          paid_to: string;
          user_lo: string;
          user_hi: string;
          amount: number;
          note: string | null;
          created_at: string;
          currency: string;
          exchange_rate: number;
          base_amount: number;
          date: string;
        };
        Insert: {
          id?: string;
          paid_by: string;
          paid_to: string;
          user_lo: string;
          user_hi: string;
          amount: number;
          note?: string | null;
          currency?: string;
          exchange_rate?: number;
          base_amount?: number;
          date?: string;
        };
        Update: {
          paid_by?: string;
          paid_to?: string;
          amount?: number;
          note?: string | null;
          currency?: string;
          exchange_rate?: number;
          base_amount?: number;
          date?: string;
        };
        Relationships: [];
      };
      contact_pair_settings: {
        Row: {
          user_lo: string;
          user_hi: string;
          currency: string;
          updated_at: string;
        };
        Insert: {
          user_lo: string;
          user_hi: string;
          currency?: string;
        };
        Update: {
          currency?: string;
        };
        Relationships: [];
      };
      contact_requests: {
        Row: {
          id: string;
          requester_id: string;
          recipient_id: string;
          status: "pending" | "accepted" | "declined";
          created_at: string;
          responded_at: string | null;
        };
        Insert: {
          id?: string;
          requester_id: string;
          recipient_id: string;
          status?: "pending" | "accepted" | "declined";
          created_at?: string;
          responded_at?: string | null;
        };
        Update: {
          status?: "pending" | "accepted" | "declined";
          responded_at?: string | null;
        };
        Relationships: [];
      };
      recurring_schedules: {
        Row: {
          id: string;
          kind: "group" | "contact";
          group_id: string | null;
          user_lo: string | null;
          user_hi: string | null;
          created_by: string | null;
          paid_by: string;
          description: string;
          category: string | null;
          amount: number;
          currency: string;
          last_exchange_rate: number;
          split_type: SplitType;
          splits: RecurringScheduleSplit[];
          start_date: string;
          tz: string;
          frequency: RecurringFrequency;
          end_date: string | null;
          max_count: number | null;
          next_index: number;
          stopped_at: string | null;
          stop_reason: RecurringStopReason | null;
          created_at: string;
          last_error: string | null;
          failed_runs: number;
        };
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      group_simplify_debts_events: {
        Row: {
          id: string;
          group_id: string;
          actor_id: string;
          enabled: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          group_id: string;
          actor_id: string;
          enabled: boolean;
          created_at?: string;
        };
        Update: {
          enabled?: boolean;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      get_group_balances: {
        Args: { p_group_id: string };
        Returns: {
          user_id: string;
          full_name: string;
          balance: number;
        }[];
      };
      get_user_total_balance: {
        Args: { p_user_id: string };
        Returns: {
          balance: number;
          currency: string;
        }[];
      };
      check_emails_registered: {
        Args: { p_emails: string[] };
        Returns: {
          email: string;
        }[];
      };
      check_group_member_email: {
        Args: { p_group_id: string; p_email: string };
        Returns: "ok" | "not_registered" | "already_member";
      };
      create_group_with_members: {
        Args: { p_name: string; p_member_emails: string[]; p_currency?: string };
        Returns: Database["public"]["Tables"]["groups"]["Row"];
      };
      add_group_members: {
        Args: { p_group_id: string; p_member_emails: string[] };
        Returns: void;
      };
      rename_group: {
        Args: { p_group_id: string; p_name: string };
        Returns: Database["public"]["Tables"]["groups"]["Row"];
      };
      get_group_pairwise_balances: {
        Args: { p_group_id: string };
        Returns: {
          from_user: string;
          from_name: string;
          to_user: string;
          to_name: string;
          amount: number;
        }[];
      };
      get_recent_activity: {
        Args: { p_limit?: number };
        Returns: {
          id: string;
          description: string;
          amount: number;
          currency: string;
          date: string;
          paid_by: string;
          group_id: string;
          payer: Profile | null;
          groups: { name: string } | null;
          expense_splits: { user_id: string; amount: number }[];
        }[];
      };
      get_upcoming_expenses: {
        Args: { p_limit?: number };
        Returns: {
          id: string;
          description: string;
          amount: number;
          currency: string;
          date: string;
          paid_by: string;
          group_id: string;
          payer: Profile | null;
          groups: { name: string } | null;
          expense_splits: { user_id: string; amount: number }[];
        }[];
      };
      get_group_simplified_edges: {
        Args: { p_group_id: string };
        Returns: {
          from_user: string;
          from_name: string;
          to_user: string;
          to_name: string;
          amount: number;
        }[];
      };
      create_expense_with_splits: {
        Args: {
          p_group_id: string;
          p_paid_by: string;
          p_amount: number;
          p_description: string;
          p_category: string | null;
          p_split_type: SplitType;
          p_splits: { userId: string; amount: number; baseAmount: number }[];
          p_date?: string | null;
          p_currency?: string;
          p_exchange_rate?: number;
        };
        Returns: Database["public"]["Tables"]["expenses"]["Row"];
      };
      update_expense_with_splits: {
        Args: {
          p_expense_id: string;
          p_paid_by: string;
          p_amount: number;
          p_description: string;
          p_category: string | null;
          p_split_type: SplitType;
          p_splits: { userId: string; amount: number; baseAmount: number }[];
          p_date?: string | null;
          p_currency?: string;
          p_exchange_rate?: number;
        };
        Returns: Database["public"]["Tables"]["expenses"]["Row"];
      };
      leave_group: {
        Args: { p_group_id: string };
        Returns: void;
      };
      send_contact_request: {
        Args: { p_recipient_email: string };
        Returns: void;
      };
      respond_contact_request: {
        Args: { p_request_id: string; p_accept: boolean };
        Returns: void;
      };
      cancel_contact_request: {
        Args: { p_request_id: string };
        Returns: void;
      };
      get_contact_requests: {
        Args: Record<string, never>;
        Returns: {
          id: string;
          direction: "incoming" | "outgoing";
          status: "pending" | "accepted" | "declined";
          created_at: string;
          user_id: string;
          full_name: string;
          avatar_url: string | null;
        }[];
      };
      create_contact_expense_with_splits: {
        Args: {
          p_contact_user_id: string;
          p_paid_by: string;
          p_amount: number;
          p_description: string;
          p_category: string | null;
          p_split_type: SplitType;
          p_splits: { userId: string; amount: number; baseAmount: number }[];
          p_date?: string | null;
          p_currency?: string;
          p_exchange_rate?: number;
        };
        Returns: Database["public"]["Tables"]["contact_expenses"]["Row"];
      };
      update_contact_expense_with_splits: {
        Args: {
          p_expense_id: string;
          p_paid_by: string;
          p_amount: number;
          p_description: string;
          p_category: string | null;
          p_split_type: SplitType;
          p_splits: { userId: string; amount: number; baseAmount: number }[];
          p_date?: string | null;
          p_currency?: string;
          p_exchange_rate?: number;
        };
        Returns: Database["public"]["Tables"]["contact_expenses"]["Row"];
      };
      create_recurring_schedule: {
        Args: {
          p_group_id: string | null;
          p_contact_id: string | null;
          p_paid_by: string;
          p_amount: number;
          p_description: string;
          p_category: string | null;
          p_split_type: SplitType;
          p_splits: { userId: string; amount: number }[];
          p_currency: string;
          p_exchange_rate: number;
          p_start_date: string;
          p_tz: string;
          p_frequency: RecurringFrequency;
          p_end_date?: string | null;
          p_max_count?: number | null;
        };
        Returns: Database["public"]["Tables"]["recurring_schedules"]["Row"];
      };
      stop_recurring_schedule: {
        Args: { p_schedule_id: string };
        Returns: Database["public"]["Tables"]["recurring_schedules"]["Row"];
      };
      materialise_my_recurring: {
        Args: Record<string, never>;
        Returns: number;
      };
      get_contact_balance: {
        Args: { p_contact_user_id: string };
        Returns: number;
      };
      get_contacts_with_balances: {
        Args: Record<string, never>;
        Returns: {
          contact_user_id: string;
          full_name: string;
          avatar_url: string | null;
          balance: number;
        }[];
      };
      get_contact_balance_contexts: {
        Args: { p_contact_user_id: string };
        Returns: {
          currency: string;
          balance: number;
        }[];
      };
      get_contact_currency: {
        Args: { p_contact_user_id: string };
        Returns: string;
      };
      set_contact_currency: {
        Args: { p_contact_user_id: string; p_currency: string };
        Returns: string;
      };
      set_group_currency: {
        Args: { p_group_id: string; p_currency: string };
        Returns: Database["public"]["Tables"]["groups"]["Row"];
      };
      set_group_simplify_debts: {
        Args: { p_group_id: string; p_enabled: boolean };
        Returns: Database["public"]["Tables"]["groups"]["Row"];
      };
      get_contacts_with_combined_balances: {
        Args: Record<string, never>;
        Returns: {
          contact_user_id: string;
          full_name: string;
          avatar_url: string | null;
          currency: string;
          balance: number;
          is_accepted: boolean;
        }[];
      };
      get_contact_group_breakdown: {
        Args: { p_contact_user_id: string };
        Returns: {
          group_id: string;
          group_name: string;
          balance: number;
          currency: string;
        }[];
      };
      update_profile: {
        Args: { p_full_name: string; p_avatar_url?: string | null };
        Returns: Database["public"]["Tables"]["profiles"]["Row"];
      };
      create_payment: {
        Args: {
          p_group_id: string;
          p_paid_by: string;
          p_paid_to: string;
          p_amount: number;
          p_note?: string | null;
          p_currency?: string | null;
          p_date?: string | null;
        };
        Returns: Database["public"]["Tables"]["payments"]["Row"];
      };
      update_payment: {
        Args: {
          p_payment_id: string;
          p_paid_by: string;
          p_paid_to: string;
          p_amount: number;
          p_note?: string | null;
          p_date?: string | null;
        };
        Returns: Database["public"]["Tables"]["payments"]["Row"];
      };
      delete_payment: {
        Args: { p_payment_id: string };
        Returns: void;
      };
      delete_expense: {
        Args: { p_expense_id: string };
        Returns: void;
      };
      create_contact_payment: {
        Args: {
          p_contact_user_id: string;
          p_paid_by: string;
          p_paid_to: string;
          p_amount: number;
          p_note?: string | null;
          p_currency?: string | null;
          p_date?: string | null;
        };
        Returns: Database["public"]["Tables"]["contact_payments"]["Row"];
      };
      update_contact_payment: {
        Args: {
          p_payment_id: string;
          p_paid_by: string;
          p_paid_to: string;
          p_amount: number;
          p_note?: string | null;
          p_date?: string | null;
        };
        Returns: Database["public"]["Tables"]["contact_payments"]["Row"];
      };
      delete_contact_payment: {
        Args: { p_payment_id: string };
        Returns: void;
      };
      delete_contact_expense: {
        Args: { p_expense_id: string };
        Returns: void;
      };
    };
    Enums: {
      split_type: SplitType;
    };
    CompositeTypes: Record<string, never>;
  };
}

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type Group = Database["public"]["Tables"]["groups"]["Row"];
export type GroupMember = Database["public"]["Tables"]["group_members"]["Row"];
export type Expense = Database["public"]["Tables"]["expenses"]["Row"];
export type ExpenseSplit = Database["public"]["Tables"]["expense_splits"]["Row"];
export type Payment = Database["public"]["Tables"]["payments"]["Row"];
export type Contact = Database["public"]["Tables"]["contacts"]["Row"];
export type ContactExpense =
  Database["public"]["Tables"]["contact_expenses"]["Row"];
export type ContactExpenseSplit =
  Database["public"]["Tables"]["contact_expense_splits"]["Row"];
export type ContactPayment =
  Database["public"]["Tables"]["contact_payments"]["Row"];
export type RecurringSchedule =
  Database["public"]["Tables"]["recurring_schedules"]["Row"];

export interface ContactWithBalance {
  contact_user_id: string;
  full_name: string;
  avatar_url: string | null;
  // null when at least one of the contact's currency contexts has no
  // exchange rate, so the combined balance is genuinely unknown.
  balance: number | null;
  is_accepted: boolean;
}

export interface ContactExpenseWithSplits extends ContactExpense {
  expense_splits: (ContactExpenseSplit & { profiles: Profile })[];
  payer: Profile;
}

export interface GroupBalance {
  user_id: string;
  full_name: string;
  balance: number;
}

export interface DebtEdge {
  from: string;
  from_name: string;
  to: string;
  to_name: string;
  amount: number;
}

export interface ExpenseWithSplits extends Expense {
  expense_splits: (ExpenseSplit & { profiles: Profile })[];
  payer: Profile;
}

export interface PaymentWithProfiles extends Payment {
  payer: Profile;
  payee: Profile;
}

export interface ContactPaymentWithProfiles extends ContactPayment {
  payer: Profile;
  payee: Profile;
}

export interface GroupWithMembers extends Group {
  group_members: (GroupMember & { profiles: Profile })[];
}

export interface ContactGroupBreakdown {
  group_id: string;
  group_name: string;
  balance: number;
  currency: string;
}

export interface ContactRequest {
  id: string;
  direction: "incoming" | "outgoing";
  status: "pending" | "accepted" | "declined";
  created_at: string;
  profile: {
    id: string;
    full_name: string;
    avatar_url: string | null;
  };
}

// One item in the global Activity feed, discriminated by `kind`.
// Every member carries the same three fields plus its own payload type, so
// sorting and keying need no per-kind branch -- only rendering does.
export type ActivityFeedItem =
  | { kind: "expense"; id: string; ts: string; payload: ActivityExpense }
  | { kind: "payment"; id: string; ts: string; payload: ActivityPayment }
  | {
      kind: "contact-expense";
      id: string;
      ts: string;
      payload: ActivityContactExpense;
    }
  | {
      kind: "contact-payment";
      id: string;
      ts: string;
      payload: ActivityContactPayment;
    }
  | {
      kind: "simplify-debts";
      id: string;
      ts: string;
      payload: ActivitySimplifyDebtsEvent;
    };

// One line of a member's debt breakdown: who they owe or are owed, and how much.
export interface BalanceBreakdown {
  direction: "owes" | "owed";
  name: string;
  amount: number;
}

// A member as the expense/payment forms need them: the id plus whatever display
// name the joined profile carries.
export interface MemberWithProfile {
  user_id: string;
  profiles?: { full_name?: string | null } | null;
}

// Flattened read shapes for the global Activity feed. Each mirrors the columns
// its query selects, not a full table row.
export interface ActivityExpense {
  id: string;
  description: string;
  amount: number;
  currency: string;
  date: string;
  paid_by: string;
  group_id: string;
  payer: Profile | null;
  groups: { name: string } | null;
  expense_splits: { user_id: string; amount: number }[];
  schedule_id?: string | null;
  occurrence_date?: string | null;
}

export interface ActivityPayment {
  id: string;
  amount: number;
  currency: string;
  date: string;
  paid_by: string;
  paid_to: string;
  group_id: string;
  note: string | null;
  payer: Profile | null;
  payee: Profile | null;
  groups: { name: string } | null;
}

export interface ActivityContactExpense {
  id: string;
  description: string;
  amount: number;
  currency: string;
  date: string;
  paid_by: string;
  user_lo: string;
  user_hi: string;
  payer: Profile | null;
  user_lo_profile: Profile | null;
  user_hi_profile: Profile | null;
  expense_splits: { user_id: string; amount: number }[];
  schedule_id?: string | null;
  occurrence_date?: string | null;
}

export interface ActivityContactPayment {
  id: string;
  amount: number;
  currency: string;
  date: string;
  paid_by: string;
  paid_to: string;
  note: string | null;
  payer: Profile | null;
  payee: Profile | null;
}

export interface ActivitySimplifyDebtsEvent {
  id: string;
  group_id: string;
  actor_id: string;
  enabled: boolean;
  created_at: string;
  actor: Profile | null;
  groups: { name: string } | null;
}
