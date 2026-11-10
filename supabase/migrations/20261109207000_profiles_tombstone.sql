-- Account deletion anonymises instead of cascading.
--
-- profiles.id referenced auth.users ON DELETE CASCADE, so removing an auth user
-- deleted the profile and, through every cascading foreign key to profiles, the
-- groups they created and all the expenses, splits, payments and contacts they
-- took part in. Drop that foreign key so a profile can outlive its auth.users
-- row, and add deleted_at to mark a tombstone: a profile whose person deleted
-- their account. Clients keep SELECT only on profiles, so only a SECURITY
-- DEFINER function can set it. handle_new_user and its trigger are unchanged.

alter table public.profiles drop constraint profiles_id_fkey;

alter table public.profiles add column deleted_at timestamptz;
