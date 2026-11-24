-- Security hardening: table privileges the API roles never use.
--
-- Verified live 2026-11-23 (information_schema.role_table_grants /
-- column_privileges):
--   * anon and authenticated held TRUNCATE, REFERENCES and TRIGGER on almost
--     every public table. TRUNCATE is NOT filtered by RLS, so any holder of
--     the anon key could empty public.reviews / public.reports / public.rides.
--   * public.rides gave authenticated INSERT (used by the "rides create"
--     policy), UPDATE and DELETE. There is no UPDATE or DELETE policy on
--     rides, so those two grants were dead weight; INSERT was worse — see the
--     fare note below.
--   * public.payments gave authenticated INSERT/UPDATE/DELETE while only a
--     SELECT policy exists (payment rows are written by start-payment and
--     paystack-webhook with the service key).
--   * public.reviews / public.reports / public.tickets / public.ride_requests
--     also carried write grants with no matching policy.
--
-- Why rides INSERT goes: public.rides.fare is set by create-ride from
-- public.fares (create-ride/index.ts reads fares.amount server-side;
-- start-payment never recomputes it, it charges rides.fare). The old
-- "rides create" policy only checked student_id = auth.uid() and
-- status = 'searching', so a student could insert their own ride directly
-- with fare = 1 and then pay ₦1 + the ₦20 fee. With INSERT revoked, create-ride
-- (service role) is the only way a ride row can come into existence.
--
-- Preserved on purpose: every grant that a live policy needs — rides SELECT,
-- payments SELECT, profiles/kekes/locations/fares/campus_settings writes for
-- the admin and self-update paths, reports UPDATE for admins, ride_locations
-- writes for the assigned rider, reviews/reports INSERT for students. The
-- service_role keeps its own full grants, so all Edge Functions are unaffected.
--
-- Safety: grants only. No row, column, policy or lifecycle rule changes.

-- ---------------------------------------------------------------------
-- 1. TRUNCATE / REFERENCES / TRIGGER are never used through PostgREST.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
  loop
    execute format(
      'revoke truncate, references, trigger on table public.%I from anon, authenticated',
      r.relname
    );
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 2. Ride creation stays exclusive to the create-ride Edge Function.
-- ---------------------------------------------------------------------
revoke insert, update, delete on table public.rides from anon, authenticated;

drop policy if exists "rides create" on public.rides;

-- ---------------------------------------------------------------------
-- 3. Payments are written only by start-payment / paystack-webhook.
-- ---------------------------------------------------------------------
revoke insert, update, delete on table public.payments from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Write grants with no policy behind them.
-- ---------------------------------------------------------------------
revoke update on table public.reviews from anon, authenticated;
revoke delete on table public.reviews from anon, authenticated;

revoke delete on table public.reports from anon, authenticated;

revoke insert, update, delete on table public.tickets from anon, authenticated;

revoke insert, delete on table public.ride_requests from anon, authenticated;

revoke insert, update, delete on table public.ride_locations from anon;
revoke delete on table public.ride_locations from authenticated;

revoke delete on table public.profiles from anon, authenticated;
revoke delete on table public.kekes from anon, authenticated;
revoke delete on table public.locations from anon, authenticated;
revoke delete on table public.fares from anon, authenticated;
revoke delete on table public.campus_settings from anon, authenticated;

revoke insert on table public.campus_settings from anon;
revoke update on table public.campus_settings from anon;
revoke insert on table public.fares from anon;
revoke update on table public.fares from anon;
revoke insert on table public.locations from anon;
revoke update on table public.locations from anon;
revoke insert on table public.kekes from anon;
revoke insert on table public.profiles from anon;
revoke insert on table public.reviews from anon;
revoke insert on table public.reports from anon;
