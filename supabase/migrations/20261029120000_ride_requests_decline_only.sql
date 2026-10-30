-- Migration: harden ride_requests so clients can only decline directly.
--
-- Verified live 2026-10-29: the UPDATE policy "requests respond" has
-- USING (keke_id = auth.uid()) but NO WITH CHECK — so a rider client could
-- write response = 'accepted' directly, bypassing respond_to_ride_request()
-- (spec section 5: "ACCEPT must call accept-ride/RPC, not edit response").
-- Writing 'accepted' directly would not assign the ride (that happens only
-- inside the RPC), but it would corrupt offer state and skip re-dispatch.
--
-- This policy keeps exactly one legal direct client write per spec section 4:
-- a keke sets ride_requests.response = 'declined' on its own request.
-- Accept / expire paths continue through the SECURITY DEFINER RPC, which
-- bypasses RLS by design and performs the guarded state transitions.
--
-- Safety: recreates a single policy; no tables, columns or rows change.

drop policy if exists "requests respond" on public.ride_requests;

create policy "requests respond" on public.ride_requests
  for update
  to authenticated
  using (keke_id = auth.uid())
  with check (keke_id = auth.uid() and response = 'declined');
