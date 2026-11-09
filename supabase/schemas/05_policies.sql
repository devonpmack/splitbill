-- Row Level Security policies (final state).
--
-- Every write goes through a SECURITY DEFINER RPC in 04_functions.sql, so the
-- tables carry SELECT policies only. That is deliberate: RLS can express "you
-- are a member of this group" but not "these splits add up to the expense
-- total", so leaving direct INSERT/UPDATE/DELETE open let a client PostgREST
-- call skip every validation the RPCs perform and write an unbalanced ledger.
-- With no policy for a command, RLS denies it.
--
-- Caveat: the diff tool tracks `create policy` but NOT `alter policy`. To
-- change a policy here, edit its definition in place; the generated migration
-- will drop and recreate it.

-- Visibility is scoped to people the caller shares something with (see
-- can_view_profile). The RPCs that legitimately need to name a non-visible
-- profile are SECURITY DEFINER and bypass this.
create policy "Users can view profiles they share context with"
  on public.profiles for select using (public.can_view_profile(id));

create policy "Members can view their groups"
  on public.groups for select
  using (
    public.is_group_member(id, auth.uid())
    or created_by = auth.uid()
  );

create policy "Members can view group members"
  on public.group_members for select
  using (public.is_group_member(group_id, auth.uid()));

create policy "Members can view group expenses"
  on public.expenses for select
  using (public.is_group_member(group_id, auth.uid()));

create policy "Members can view expense splits"
  on public.expense_splits for select
  using (expense_id in (
    select e.id from public.expenses e
    where public.is_group_member(e.group_id, auth.uid())
  ));

create policy "Members can view group payments"
  on public.payments for select
  using (public.is_group_member(group_id, auth.uid()));

create policy "Members can view simplify debts events"
  on public.group_simplify_debts_events for select
  using (public.is_group_member(group_id, auth.uid()));

create policy "Users can view their contacts"
  on public.contacts for select using (owner_id = auth.uid());

create policy "Participants can view contact expenses"
  on public.contact_expenses for select
  using (auth.uid() = user_lo or auth.uid() = user_hi);

create policy "Participants can view contact expense splits"
  on public.contact_expense_splits for select
  using (public.is_contact_participant(expense_id, auth.uid()));

create policy "Participants can view contact payments"
  on public.contact_payments for select
  using (auth.uid() = user_lo or auth.uid() = user_hi);

create policy "Participants can view contact requests"
  on public.contact_requests for select
  using (requester_id = auth.uid() or recipient_id = auth.uid());

create policy "Participants can view contact pair settings"
  on public.contact_pair_settings for select
  using (auth.uid() = user_lo or auth.uid() = user_hi);

create policy "Members can view group recurring schedules"
  on public.recurring_schedules for select
  using (public.is_group_member(group_id, auth.uid()));

create policy "Participants can view contact recurring schedules"
  on public.recurring_schedules for select
  using (auth.uid() = user_lo or auth.uid() = user_hi);
