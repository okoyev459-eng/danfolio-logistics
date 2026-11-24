-- Live tracking is readable only AFTER the payment has been verified.
--
-- Verified live 2026-11-23 (pg_policies):
--   ride_locations "ride_locations read"
--     USING (is_admin() OR EXISTS (rides r
--       WHERE r.id = ride_locations.ride_id
--         AND r.keke_id IS NOT NULL
--         AND r.status IN ('accepted','paid','arrived','on_trip')
--         AND (r.student_id = auth.uid() OR r.keke_id = auth.uid())))
--
-- 'accepted' means a keke took the booking but the student has NOT paid yet
-- (paystack-webhook is what moves accepted -> paid). Including it let a
-- student watch the rider's GPS before any money changed hands, which leaks a
-- rider's movements to someone who may never pay. That is the pre-payment
-- tracking leak found in the audit.
--
-- New contract — a student reads a rider's position only when ALL hold:
--   1. a keke is assigned (r.keke_id IS NOT NULL),
--   2. the payment has been verified (status paid / arrived / on_trip — every
--      one of those is reachable only after paystack-webhook confirmed the
--      charge, or after a payment-aware accept flipped the ride to 'paid'),
--   3. it is still this student's own ride.
-- The assigned rider keeps reading/writing its own row exactly as before.
--
-- Revocation is automatic and needs no extra code: 'cancelled' and 'refunded'
-- fall outside the list, so tracking access ends the moment the ride leaves the
-- paid states. Realtime postgres_changes applies these same RLS policies to
-- every subscriber, so a student's subscription stops delivering updates too.
-- (A student who already received coordinates keeps the last fix; Realtime
-- cannot recall a row that was delivered.)
--
-- The rider's WRITE policies are deliberately unchanged: the assigned keke may
-- publish while 'accepted' so its position is already fresh when the student
-- pays. Writing own coordinates is not the leak; reading them is.
--
-- Safety: one SELECT policy replaced. No table, column, row, grant, trigger or
-- lifecycle rule changes, and nothing else about dispatch moves.

drop policy if exists "ride_locations read" on public.ride_locations;

create policy "ride_locations read"
  on public.ride_locations
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
      from public.rides r
      where r.id = ride_locations.ride_id
        and r.keke_id is not null
        and r.status in ('paid', 'arrived', 'on_trip')
        and (r.student_id = auth.uid() or r.keke_id = auth.uid())
    )
  );

comment on policy "ride_locations read" on public.ride_locations is
  'Admin, the ride''s own student AFTER payment is verified (paid/arrived/on_trip), or the assigned rider. Ends automatically on cancel/refund.';
