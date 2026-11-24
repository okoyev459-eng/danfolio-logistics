-- Security hardening: reviews and reports must point at the student's own ride.
--
-- Verified live 2026-11-23 (pg_policies):
--   reviews "reviews create"  WITH CHECK (student_id = auth.uid())
--   reports "reports create"  WITH CHECK (student_id = auth.uid())
-- Neither policy looks at the ride, so a student could insert a review for any
-- ride_id they could guess — including another student's completed ride — and
-- the reviews_sync_keke_rating trigger would fold the 1-star into that rider's
-- public rating. reports had the same hole plus an arbitrary keke_id, so a
-- student could file a report naming any rider.
--
-- Ride statuses are the real enum values (public.ride_status):
--   searching, accepted, paid, arrived, on_trip, completed, cancelled, refunded
-- A review therefore requires status = 'completed', which is exactly what the
-- student Review screen already offers (src/pages/student/Review.jsx).
--
-- Reports deliberately do NOT require 'completed': the Report screen is also
-- reachable during a live trip, so any ride the student owns is accepted.
--
-- NOT added here: a UNIQUE constraint on reviews.ride_id. Live check found
-- 0 duplicate ride_id values (public.reviews is empty), but the app already
-- reports "You have already reviewed this ride." by catching code 23505, so a
-- unique index is a separate decision — flagged in the report, not applied.
--
-- Safety: two policies replaced; no rows, columns or grants change.

drop policy if exists "reviews create" on public.reviews;

create policy "reviews create" on public.reviews
  for insert
  to authenticated
  with check (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.rides r
      where r.id = reviews.ride_id
        and r.student_id = (select auth.uid())
        and r.status = 'completed'
    )
  );

drop policy if exists "reports create" on public.reports;

create policy "reports create" on public.reports
  for insert
  to authenticated
  with check (
    student_id = (select auth.uid())
    and exists (
      select 1
      from public.rides r
      where r.id = reports.ride_id
        and r.student_id = (select auth.uid())
        and r.keke_id = reports.keke_id
    )
  );
