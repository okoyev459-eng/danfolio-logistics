-- delete-all-booked-rides.sql — wipe EVERY booked ride (full test-data reset).
--
-- What it removes, in FK-safe order (children first):
--   1. reports / reviews / tickets / payments attached to rides
--      (these FK to rides with ON DELETE NO ACTION — they MUST go first)
--   2. ride_requests + ride_locations for those rides (also cascade from rides)
--   3. the rides themselves (all 40: searching→…→completed, every status)
--   4. riders left stuck in 'on_trip' with no rides anymore -> offline
--
-- What it keeps: profiles, kekes, auth accounts, fares, locations,
-- campus settings — i.e. every USER and RIDER stays registered.
--
-- Runs as ONE transaction: it either all commits or all rolls back.
-- Apply by pasting this file into the Supabase SQL editor (Dashboard →
-- SQL Editor → New query → Run). It is reviewed and run by the project
-- owner; nothing here runs automatically.

begin;

-- 1. Ride-attached children that would otherwise block the ride delete.
delete from public.reports  where ride_id in (select id from public.rides);
delete from public.reviews  where ride_id in (select id from public.rides);
delete from public.tickets  where ride_id in (select id from public.rides);
delete from public.payments where ride_id in (select id from public.rides);

-- 2. Dispatch + GPS rows (would cascade, but explicit keeps the order obvious).
delete from public.ride_requests  where ride_id in (select id from public.rides);
delete from public.ride_locations where ride_id in (select id from public.rides);

-- 3. Every booked ride.
delete from public.rides;

-- 4. A rider whose trips are all gone must not stay locked as 'on_trip'
--    (they could never go online or join a station queue again).
update public.kekes
   set status = 'offline',
       queue_joined_at = null
 where status = 'on_trip'
   and not exists (select 1 from public.rides r where r.keke_id = kekes.id);

commit;
