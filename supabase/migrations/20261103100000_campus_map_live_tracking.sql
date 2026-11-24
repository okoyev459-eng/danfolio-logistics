-- Migration: campus settings + per-ride live GPS tracking (map feature set).
--
-- Additive only: two NEW tables, RLS policies, one trigger, one realtime
-- publication entry. No existing table, column, status, ride, payment or
-- policy is modified; nothing is deleted; no rows are invented.
--
-- 1. campus_settings — ONE row (id = 1) holding the university campus name
--    and the map's centre/zoom. Readable by signed-in users (the app uses it
--    as the initial map camera + title); writable by admins only. All columns
--    nullable: the campus coordinates have NOT been supplied yet, so the app
--    falls back to env defaults until the admin enters them.
--
-- 2. ride_locations — the CURRENT GPS position of the assigned keke for each
--    active ride (one row per ride, upserted by the rider's device while a
--    ride is active). Columns: ride_id, keke_id, lat/lng, accuracy, heading,
--    speed, updated_at. `updated_at` is stamped server-side by trigger so
--    freshness displays cannot be forged by the client.
--
--    RLS contract:
--      * read  — the ride's own student OR its assigned keke, and only while
--                the ride is active (accepted/paid/arrived/on_trip); admins
--                always (audit). When the ride finishes the participants'
--                access ends — location sharing stops by construction.
--      * write — ONLY the assigned keke of that ride, ONLY while the ride is
--                active (insert + update WITH CHECK). Students have no write
--                policy at all, so they cannot modify rider GPS coordinates;
--                an unrelated rider cannot touch another rider's row.
--      * delete — the assigned keke (own ride rows, any status, so a rider
--                 can clean up after a ride ends) and admins.
--
--    Realtime: ride_locations is added to the `supabase_realtime` publication
--    so students receive UPDATE events for their own ride's row (postgres_changes
--    applies these same RLS policies to each subscriber).
--
-- Compatibility: the frontend feature-detects this table. If this migration
-- has not been applied yet, the app keeps today's behaviour (kekes heartbeat)
-- and shows a plain "live tracking not enabled" state instead of erroring.

-- =========================================================================
-- 1. campus_settings
-- =========================================================================
create table if not exists public.campus_settings (
  id          smallint primary key check (id = 1),
  campus_name text,
  center_lat  double precision,
  center_lng  double precision,
  zoom        smallint,
  updated_at  timestamptz not null default now(),
  constraint campus_settings_center_check check (
    (center_lat is null and center_lng is null)
    or (center_lat between -90 and 90 and center_lng between -180 and 180)
  ),
  constraint campus_settings_zoom_check check (
    zoom is null or zoom between 1 and 20
  )
);

alter table public.campus_settings enable row level security;

drop policy if exists "campus_settings read" on public.campus_settings;
create policy "campus_settings read"
  on public.campus_settings
  for select
  to authenticated
  using (true);

drop policy if exists "campus_settings write" on public.campus_settings;
create policy "campus_settings write"
  on public.campus_settings
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

grant select on public.campus_settings to authenticated;
grant insert, update, delete on public.campus_settings to authenticated;

-- =========================================================================
-- 2. ride_locations (one CURRENT position per active ride)
-- =========================================================================
create table if not exists public.ride_locations (
  ride_id    uuid primary key references public.rides (id) on delete cascade,
  keke_id    uuid not null references public.kekes (id) on delete cascade,
  lat        double precision not null check (lat between -90 and 90),
  lng        double precision not null check (lng between -180 and 180),
  accuracy   double precision check (accuracy is null or accuracy >= 0),
  heading    double precision check (heading is null or (heading >= 0 and heading <= 360)),
  speed      double precision check (speed is null or speed >= 0),
  updated_at timestamptz not null default now()
);

create index if not exists ride_locations_keke_id_idx
  on public.ride_locations (keke_id);

alter table public.ride_locations enable row level security;
-- PK-based replica identity (Postgres default): UPDATE events carry the full
-- new row, which is all the student's tracker reads.

-- Server-authoritative freshness: whatever the client sends, updated_at is
-- the DB clock at the moment the row landed.
create or replace function public.touch_ride_location()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ride_locations_touch on public.ride_locations;
create trigger ride_locations_touch
  before insert or update on public.ride_locations
  for each row
  execute function public.touch_ride_location();

-- Helper predicate: does the CURRENT auth context own this ride as its
-- assigned keke, with the ride still active? Inlined in policies below (the
-- existing policy style references rides directly).

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
        and r.status in ('accepted', 'paid', 'arrived', 'on_trip')
        and (r.student_id = auth.uid() or r.keke_id = auth.uid())
    )
  );

drop policy if exists "ride_locations publish" on public.ride_locations;
create policy "ride_locations publish"
  on public.ride_locations
  for insert
  to authenticated
  with check (
    keke_id = auth.uid()
    and exists (
      select 1
      from public.rides r
      where r.id = ride_locations.ride_id
        and r.keke_id = auth.uid()
        and r.status in ('accepted', 'paid', 'arrived', 'on_trip')
    )
  );

drop policy if exists "ride_locations update" on public.ride_locations;
create policy "ride_locations update"
  on public.ride_locations
  for update
  to authenticated
  using (
    keke_id = auth.uid()
    and exists (
      select 1
      from public.rides r
      where r.id = ride_locations.ride_id
        and r.keke_id = auth.uid()
        and r.status in ('accepted', 'paid', 'arrived', 'on_trip')
    )
  )
  with check (
    keke_id = auth.uid()
    and exists (
      select 1
      from public.rides r
      where r.id = ride_locations.ride_id
        and r.keke_id = auth.uid()
        and r.status in ('accepted', 'paid', 'arrived', 'on_trip')
    )
  );

drop policy if exists "ride_locations delete" on public.ride_locations;
create policy "ride_locations delete"
  on public.ride_locations
  for delete
  to authenticated
  using (public.is_admin() or keke_id = auth.uid());

grant select on table public.ride_locations to authenticated;
grant insert, update, delete on table public.ride_locations to authenticated;
revoke all on table public.ride_locations from anon;

-- =========================================================================
-- 3. Realtime publication (postgres_changes for ride_locations)
-- =========================================================================
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ride_locations'
  ) then
    alter publication supabase_realtime add table public.ride_locations;
  end if;
exception
  when undefined_object then
    -- Fresh project without the publication (not expected on Supabase).
    create publication supabase_realtime;
    alter publication supabase_realtime add table public.ride_locations;
end;
$$;
