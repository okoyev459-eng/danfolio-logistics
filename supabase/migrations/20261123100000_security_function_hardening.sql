-- Security hardening: SECURITY DEFINER search_path, and EXECUTE grants on
-- internal functions.
--
-- Verified live 2026-11-23 over the pooler (pg_proc / pg_policies):
--   * is_admin()        SECURITY DEFINER, search_path=public
--   * handle_new_user() SECURITY DEFINER, search_path=public
--   * lock_keke_number(), touch_ride_location() had no search_path at all
--   * release_keke_if_idle(), keke_active_ride_count(), sync_keke_rating(),
--     lock_keke_number(), touch_ride_location(), handle_new_user() and
--     is_admin() were executable by PUBLIC (proacl starts with "=X/"),
--     i.e. by anon — release_keke_if_idle() is SECURITY DEFINER and does no
--     auth check of its own, so anyone holding the anon key could call it via
--     /rest/v1/rpc and flip a rider's status.
--
-- Callers confirmed before revoking (grep over supabase/functions):
--   release_keke_if_idle      complete-trip, cancel-ride, refund-ride,
--                             rider-cancel-ride — all via the service-role
--                             client (admin.rpc).
--   keke_active_ride_count    rider-cancel-ride via the service-role client,
--                             plus dispatch/respond_to_ride_request (both
--                             SECURITY DEFINER, run as the owner).
--   sync_keke_rating          reviews trigger only.
--   lock_keke_number          kekes trigger only.
--   touch_ride_location       ride_locations trigger only.
--   handle_new_user           on_auth_user_created trigger only.
--   is_admin / is_keke        RLS policies (role: authenticated).
--
-- Trigger functions need no EXECUTE privilege to fire: the trigger is
-- dispatched by the executor. Signup therefore keeps working.
--
-- Safety: only function definitions and ACLs change. No table, row, policy or
-- lifecycle rule is touched, and no scheduling (cron.job) is altered.

-- ---------------------------------------------------------------------
-- 1. Pin search_path and fully qualify everything referenced inside.
-- ---------------------------------------------------------------------

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
  );
$function$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.profiles (id, full_name, phone, matric_no)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', ''),
          new.raw_user_meta_data->>'phone',
          new.raw_user_meta_data->>'matric_no');
  return new;
end $function$;

create or replace function public.lock_keke_number()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if new.keke_number <> old.keke_number then
    raise exception 'keke_number cannot be changed';
  end if;
  return new;
end $function$;

create or replace function public.touch_ride_location()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$function$;

-- ---------------------------------------------------------------------
-- 2. EXECUTE grants: nothing internal stays reachable from the API roles.
-- ---------------------------------------------------------------------

-- RLS policies call these two, so `authenticated` keeps EXECUTE.
revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated, service_role;

revoke all on function public.is_keke() from public;
revoke all on function public.is_keke() from anon;
grant execute on function public.is_keke() to authenticated, service_role;

-- Trigger-only functions: no API role needs to call them directly.
revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon, authenticated;
grant execute on function public.handle_new_user() to service_role;

revoke all on function public.lock_keke_number() from public;
revoke all on function public.lock_keke_number() from anon, authenticated;
grant execute on function public.lock_keke_number() to service_role;

revoke all on function public.touch_ride_location() from public;
revoke all on function public.touch_ride_location() from anon, authenticated;
grant execute on function public.touch_ride_location() to service_role;

revoke all on function public.sync_keke_rating() from public;
revoke all on function public.sync_keke_rating() from anon, authenticated;
grant execute on function public.sync_keke_rating() to service_role;

-- Server-side helpers called only by Edge Functions with the service key.
revoke all on function public.keke_active_ride_count(uuid) from public;
revoke all on function public.keke_active_ride_count(uuid) from anon, authenticated;
grant execute on function public.keke_active_ride_count(uuid) to service_role;

revoke all on function public.release_keke_if_idle(uuid) from public;
revoke all on function public.release_keke_if_idle(uuid) from anon, authenticated;
grant execute on function public.release_keke_if_idle(uuid) to service_role;

-- respond_to_ride_request() and dispatch_next_ride_request() already had no
-- PUBLIC/anon grant and keep `authenticated` (they carry their own auth
-- checks). Left exactly as found.
