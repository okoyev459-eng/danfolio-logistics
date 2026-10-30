-- Migration: column-level write limits for profiles + kekes (spec contracts).
--
-- Verified live 2026-10-29 (read-only):
--   * public.profiles has NO self-update policy at all: a student's profile
--     photo upload (spec G5) would match 0 rows and silently not save.
--   * public.kekes has an own-row UPDATE policy with no column restriction,
--     so a rider client could rewrite keke_number / rating, but spec section 4
--     says keke_number is immutable and only these columns are client-writable:
--     status, station_id, queue_joined_at, lat, lng, last_seen.
--
-- This migration:
--   1. adds the missing self-update policy for profiles (own row only);
--   2. narrows the API UPDATE grant on profiles to avatar_url only
--      (spec G5: students may not edit other profile columns);
--   3. narrows the API UPDATE grant on kekes to the six spec columns.
--
-- Nothing here affects server-side writes: the service-role key has its own
-- grants (edge functions unaffected), and the dispatch/accept RPCs are
-- SECURITY DEFINER (owner unaffected). No rows, columns or statuses change.
--
-- Note: grants apply to every API user of `authenticated`, including admins —
-- by design there is no admin profile/keke-column edit UI in the app, so no
-- current screen is affected. Other profile columns remain editable through
-- the Supabase dashboard SQL editor (postgres role), which is not bound by
-- these grants.

-- 1. Students may update their own profile row (spec G5 photo upload).
create policy "profiles self update"
  on public.profiles
  for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- 2. Only avatar_url may be updated through the API.
revoke update on table public.profiles from anon, authenticated;
grant update (avatar_url) on table public.profiles to authenticated;

-- 3. Keke client writes limited to the spec section 4 column list
--    (keke_number becomes immutable; rating stays server-computed).
revoke update on table public.kekes from anon, authenticated;
grant update (status, station_id, queue_joined_at, lat, lng, last_seen)
  on table public.kekes to authenticated;
