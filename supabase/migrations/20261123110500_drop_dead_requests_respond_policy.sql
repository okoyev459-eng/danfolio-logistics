-- Remove the dead "requests respond" policy (no matching UPDATE grant).
--
-- Verified live 2026-11-23:
--   * pg_policies has "requests respond" FOR UPDATE on public.ride_requests
--     (USING keke_id = auth.uid(), WITH CHECK response = 'declined');
--   * information_schema.role_table_grants shows authenticated has SELECT,
--     REFERENCES, TRIGGER, TRUNCATE on ride_requests but NO UPDATE — so the
--     policy can never be reached through PostgREST. It is configuration that
--     LOOKS like a write path and does nothing.
--
-- Declining does not need it: the rider app calls
-- respond_to_ride_request(request_id, 'declined') — a SECURITY DEFINER RPC
-- that owns every transition and bypasses RLS by design (verified in
-- src/pages/keke/Home.jsx and supabase/functions/_shared/policy.js).
--
-- The obvious "fix" — GRANT UPDATE so the policy works — is refused on
-- purpose: it would hand riders a direct UPDATE path on an offer row that
-- bypasses the RPC's advisory locks, TTL checks, capacity gate and
-- re-dispatch, which is exactly what 20261029120000 exists to prevent.
--
-- revoked UPDATE is asserted (not granted): if a future migration grants it,
-- this revoke keeps the dead path closed.
--
-- Safety: drops one unreachable policy and re-revokes a privilege that is not
-- currently held. No table, row, column, function, grant-to-a-caller or
-- lifecycle rule changes.

drop policy if exists "requests respond" on public.ride_requests;

revoke update on table public.ride_requests from anon, authenticated;
