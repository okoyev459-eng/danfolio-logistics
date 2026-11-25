-- =====================================================================
-- Notifications + rider push subscriptions (Danfolio Phase 1).
--
-- Goal: every user-visible ride/payment event becomes a row in
-- `notifications`, and each row fans out to `push_deliveries` for every
-- active Web Push subscription the recipient owns. A scheduled Edge
-- Function (`notify-tick`) delivers pending pushes and expires stale
-- riders. Nothing here can make a ride, payment or refund fail:
--
--   * every trigger function is SECURITY DEFINER + exception-swallowing
--     (`begin ... exception when others then null end`) — a notification
--     failure rolls back only its own subtransaction, never the ride
--     update that fired it;
--   * triggers are AFTER-only: they observe confirmed state and can not
--     influence it;
--   * no existing function, RPC, policy or grant is modified — dispatch
--     (`dispatch_next_ride_request` / `respond_to_ride_request`),
--     `match-tick` scheduling (pg_cron + pg_net at 15s), the 3-passenger
--     cap, decline-only flow and every cancel/refund path are untouched;
--   * notifications never write to `rides`, `payments` or `kekes`.
--
-- Event sources (all confirmed server-side transitions, never client
-- claims):
--   rides.status       accepted -> student, arrived -> student,
--                      paid -> assigned rider   (trigger, WHEN old/new)
--   ride_events        to_status='cancelled' -> student;
--                      event='booking_cancelled' -> assigned rider
--                        (written only by cancel-ride = student/admin);
--                      refund_initiated / refund_processed / refund_failed
--                        -> student   (one notification per ride+type)
--   ride_requests      a new pending offer -> the OFFERED rider only.
--                      Dispatch already filters candidates (status in
--                      ('online','on_trip') AND last_seen >= now-75s,
--                      distance/queue/rating order, one offer at a time),
--                      so "the offered rider" IS "an eligible ONLINE
--                      rider". Broadcasting to every online rider would
--                      contradict the single-offer protocol and race the
--                      accept RPC — deliberately not done.
--
-- Dedupe / idempotency: `notifications.dedupe_key` is UNIQUE. Retries,
-- double audit writes and re-deliveries of the same logical event insert
-- nothing the second time (on conflict do nothing).
--
-- Presence: `keke_heartbeat()` stamps last_seen SERVER-side (the client
-- can not backdate it) and `keke_set_presence()` is the only
-- client-facing status write — own row only (auth.uid()), never
-- 'on_trip' (server-managed), never another user's row. The existing
-- direct column grants from 20261029140000 stay in place so the current
-- 20s client heartbeat keeps working until Theo migrates to the RPCs
-- (integration doc). Stale 'online' riders expire after 45s inside
-- notify-tick (touching ONLY 'online', never 'on_trip'); dispatch's own
-- 75s freshness filter already excluded them before the sweep runs.
--
-- Roles / privileges (least privilege, explicit after Supabase default
-- ALL-grants on new tables):
--   notifications     authenticated: SELECT (RLS own/admin) +
--                     column-level UPDATE (read_at only). No INSERT,
--                     no DELETE — rows are server-written only.
--   push_subscriptions authenticated: full CRUD but RLS-locked to
--                     user_id = auth.uid() (register / rotate / revoke
--                     own subscription; never another user's).
--   push_deliveries   no client privileges at all (service role only).
--   internal fns      execute revoked from public/anon/authenticated.
--   RPCs              keke_heartbeat + keke_set_presence executable by
--                     authenticated only.
--
-- Realtime: `notifications` joins the supabase_realtime publication so
-- Theo's client can show in-app toasts without polling.
--
-- One-time setup lives OUTSIDE this migration (same as match-tick): the
-- notify-tick cron job SQL + Vault secret are documented in
-- config.toml [functions.notify-tick] and docs/notifications-integration.md.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  user_role   text not null check (user_role in ('student', 'keke', 'admin')),
  type        text not null check (type in (
                'ride_accepted',
                'ride_arrived',
                'ride_cancelled',
                'ride_paid',
                'new_ride_request',
                'student_cancelled',
                'refund_initiated',
                'refund_completed',
                'refund_failed'
              )),
  title       text not null,
  body        text not null,
  ride_id     uuid references public.rides (id) on delete cascade,
  data        jsonb not null default '{}'::jsonb,
  -- Idempotency key: one row per logical event, forever.
  dedupe_key  text not null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

create unique index notifications_dedupe_key
  on public.notifications (dedupe_key);

create index notifications_user_feed
  on public.notifications (user_id, created_at desc);

create table public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- Browser push endpoint = natural key; re-subscribing rotates keys on
  -- the same endpoint, so upsert on conflict keeps exactly one row.
  endpoint     text not null unique,
  p256dh       text not null,
  auth         text not null,
  disabled     boolean not null default false,
  last_seen_at timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

create index push_subscriptions_user
  on public.push_subscriptions (user_id) where not disabled;

create table public.push_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications (id) on delete cascade,
  subscription_id uuid not null references public.push_subscriptions (id) on delete cascade,
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  sent_at         timestamptz,
  created_at      timestamptz not null default now()
);

create index push_deliveries_due
  on public.push_deliveries (next_attempt_at)
  where status = 'pending';

-- ---------------------------------------------------------------------
-- 2. RLS + grants
-- ---------------------------------------------------------------------

alter table public.notifications        enable row level security;
alter table public.push_subscriptions   enable row level security;
alter table public.push_deliveries     enable row level security;

-- notifications: read own (or any, for admins); mark own as read.
-- The column-level UPDATE grant below limits clients to read_at only,
-- so user_id / type / dedupe_key can never be rewritten from the API.
create policy "notifications read own"
  on public.notifications for select
  to authenticated
  using (user_id = auth.uid() or is_admin());

create policy "notifications mark own read"
  on public.notifications for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke insert, update, delete on table public.notifications from anon, authenticated;
grant select on table public.notifications to authenticated;
grant update (read_at) on table public.notifications to authenticated;

-- push_subscriptions: full CRUD on OWN rows only (register, rotate keys,
-- revoke). RLS makes cross-user writes impossible even with the grants.
create policy "subscriptions own all"
  on public.push_subscriptions for all
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on table public.push_subscriptions from anon;
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

-- push_deliveries: service role only (RLS with no client policies).
revoke all on table public.push_deliveries from anon, authenticated;

-- Strip Supabase's default ALL-grant leftovers that RLS does NOT cover
-- (TRUNCATE bypasses RLS entirely; REFERENCES/TRIGGER are server-only).
-- Mirrors 20261123100500's least-privilege posture on the other tables.
revoke truncate, references, trigger
  on table public.notifications from anon, authenticated;
revoke truncate, references, trigger
  on table public.push_subscriptions from anon, authenticated;

-- Internal helpers: never callable from the API (revoked after the
-- function is created, see section 3).

-- ---------------------------------------------------------------------
-- 3. Enqueue helper (server-side fan-out)
-- ---------------------------------------------------------------------

-- Inserts the notification (idempotent on dedupe_key) and creates one
-- pending push delivery per ACTIVE subscription the recipient owns.
-- Returns the notification id, or NULL when the event was a duplicate.
create or replace function public.notify_enqueue(
  p_user_id     uuid,
  p_role        text,
  p_type        text,
  p_title       text,
  p_body        text,
  p_ride_id     uuid,
  p_dedupe_key  text,
  p_data        jsonb default '{}'::jsonb
) returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid;
begin
  if p_user_id is null or p_dedupe_key is null then
    return null;
  end if;

  insert into public.notifications
    (user_id, user_role, type, title, body, ride_id, data, dedupe_key)
  values
    (p_user_id, p_role, p_type, p_title, p_body, p_ride_id, p_data, p_dedupe_key)
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    return null;  -- duplicate event, nothing to deliver
  end if;

  insert into public.push_deliveries (notification_id, subscription_id)
  select v_id, ps.id
  from public.push_subscriptions ps
  where ps.user_id = p_user_id
    and not ps.disabled;

  return v_id;
end;
$function$;

-- Not callable from the API (triggers and postgres only).
revoke execute on function public.notify_enqueue(uuid, text, text, text, text, uuid, text, jsonb)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- 4. Triggers (AFTER-only, exception-swallowing)
-- ---------------------------------------------------------------------

-- 4a. rides.status transitions.
create or replace function public.notify_on_ride_status()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if NEW.status = 'accepted' then
    perform public.notify_enqueue(
      NEW.student_id, 'student', 'ride_accepted',
      'Rider accepted',
      'Your rider is on the way.',
      NEW.id, 'accepted:' || NEW.id || ':' || coalesce(NEW.keke_id::text, '-'),
      jsonb_build_object('ride_id', NEW.id));
  elsif NEW.status = 'arrived' then
    perform public.notify_enqueue(
      NEW.student_id, 'student', 'ride_arrived',
      'Rider arrived',
      'Your rider has arrived at the pickup point.',
      NEW.id, 'arrived:' || NEW.id,
      jsonb_build_object('ride_id', NEW.id));
  elsif NEW.status = 'paid' and NEW.keke_id is not null then
    perform public.notify_enqueue(
      NEW.keke_id, 'keke', 'ride_paid',
      'Payment confirmed',
      'The student has paid for this ride.',
      NEW.id, 'paid:' || NEW.id,
      jsonb_build_object('ride_id', NEW.id));
  end if;
  return NEW;
exception
  when others then
    return NEW;  -- a notification failure must never fail the ride update
end;
$function$;

create trigger trg_notify_ride_status
  after update on public.rides
  for each row
  when (old.status is distinct from new.status)
  execute function public.notify_on_ride_status();

-- 4b. ride_events: cancellations (actor-aware) and the refund lifecycle.
create or replace function public.notify_on_ride_event()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_student uuid;
  v_keke    uuid;
begin
  -- Student learns about EVERY confirmed cancellation of their ride
  -- (student, rider, admin or the dispatcher's no-candidates auto-cancel).
  if NEW.to_status = 'cancelled' and NEW.ride_id is not null then
    select student_id, keke_id into v_student, v_keke
    from public.rides where id = NEW.ride_id;

    if v_student is not null then
      perform public.notify_enqueue(
        v_student, 'student', 'ride_cancelled',
        'Ride cancelled',
        case when NEW.reason is not null
             then 'Your ride was cancelled: ' || NEW.reason
             else 'Your ride was cancelled.' end,
        NEW.ride_id, 'cancelled:' || NEW.ride_id || ':' || NEW.id,
        jsonb_build_object('ride_id', NEW.ride_id, 'reason', NEW.reason));
    end if;

    -- The assigned rider learns about a STUDENT-side cancellation only:
    -- booking_cancelled is written exclusively by cancel-ride (the
    -- student/admin path). Rider-initiated cancellations write their own
    -- events (trip_interrupted, redispatch_requested, ...) and never
    -- reach this branch, so a rider is never told they cancelled
    -- themselves.
    if NEW.event = 'booking_cancelled' and v_keke is not null then
      perform public.notify_enqueue(
        v_keke, 'keke', 'student_cancelled',
        'Student cancelled the ride',
        'The student cancelled this ride.',
        NEW.ride_id, 'student-cancelled:' || NEW.ride_id || ':' || NEW.id,
        jsonb_build_object('ride_id', NEW.ride_id));
    end if;
  end if;

  -- Refund lifecycle -> student, one notification per ride + type.
  -- Keyed by type (not event id) so a retried audit write or a second
  -- refund_failed row can never double-notify.
  if NEW.event in ('refund_initiated', 'refund_processed', 'refund_failed')
     and NEW.ride_id is not null then
    select student_id into v_student from public.rides where id = NEW.ride_id;

    if v_student is not null then
      if NEW.event = 'refund_initiated' then
        perform public.notify_enqueue(
          v_student, 'student', 'refund_initiated',
          'Refund started',
          'Your refund has been initiated.',
          NEW.ride_id, 'refund-initiated:' || NEW.ride_id,
          jsonb_build_object('ride_id', NEW.ride_id));
      elsif NEW.event = 'refund_processed' then
        perform public.notify_enqueue(
          v_student, 'student', 'refund_completed',
          'Refund completed',
          'Your refund has been completed.',
          NEW.ride_id, 'refund-completed:' || NEW.ride_id,
          jsonb_build_object('ride_id', NEW.ride_id));
      else
        perform public.notify_enqueue(
          v_student, 'student', 'refund_failed',
          'Refund needs attention',
          'Your refund could not be completed. Our team is reviewing it.',
          NEW.ride_id, 'refund-failed:' || NEW.ride_id,
          jsonb_build_object('ride_id', NEW.ride_id));
      end if;
    end if;
  end if;

  return NEW;
exception
  when others then
    return NEW;
end;
$function$;

create trigger trg_notify_ride_event
  after insert on public.ride_events
  for each row
  execute function public.notify_on_ride_event();

-- 4c. New dispatch offer -> the OFFERED rider only (see header note).
create or replace function public.notify_on_new_request()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if NEW.response = 'pending' and NEW.keke_id is not null then
    perform public.notify_enqueue(
      NEW.keke_id, 'keke', 'new_ride_request',
      'New ride request',
      'A student needs a ride. Accept before the offer expires.',
      NEW.ride_id,
      'offer:' || NEW.id,
      jsonb_build_object(
        'ride_id', NEW.ride_id,
        'request_id', NEW.id,
        'expires_at', NEW.expires_at));
  end if;
  return NEW;
exception
  when others then
    return NEW;
end;
$function$;

create trigger trg_notify_new_request
  after insert on public.ride_requests
  for each row
  execute function public.notify_on_new_request();

-- ---------------------------------------------------------------------
-- 5. Presence RPCs (authenticated, own row only, server timestamps)
-- ---------------------------------------------------------------------

-- Foreground heartbeat: stamps last_seen with NOW() on the server — the
-- client can not backdate or forge freshness. Only a rider already on
-- duty ('online' / 'on_trip') heartbeats; an offline row is untouched.
-- Lat/lng are optional (kept when null).
create or replace function public.keke_heartbeat(
  p_lat double precision default null,
  p_lng double precision default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id     uuid := auth.uid();
  v_status text;
begin
  if v_id is null then
    raise exception 'Not authenticated';
  end if;

  update public.kekes
     set last_seen = now(),
         lat = coalesce(p_lat, lat),
         lng = coalesce(p_lng, lng)
   where id = v_id
     and status in ('online', 'on_trip')
  returning status into v_status;

  if v_status is null then
    return jsonb_build_object('ok', false, 'error', 'not_on_duty');
  end if;

  return jsonb_build_object('ok', true, 'status', v_status, 'last_seen', now());
end;
$function$;

-- Explicit presence change (go online / offline / unavailable).
-- Own row only; 'on_trip' is server-managed and rejected as input;
-- another user's row can never match auth.uid().
create or replace function public.keke_set_presence(p_status text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_id uuid := auth.uid();
begin
  if v_id is null then
    raise exception 'Not authenticated';
  end if;

  if p_status not in ('online', 'offline', 'unavailable') then
    raise exception 'Invalid status';
  end if;

  update public.kekes
     set status = p_status,
         last_seen = now()
   where id = v_id
     and status in ('online', 'on_trip', 'offline', 'unavailable');

  if not found then
    return jsonb_build_object('ok', false, 'error', 'no_keke_row');
  end if;

  return jsonb_build_object('ok', true, 'status', p_status, 'last_seen', now());
end;
$function$;

grant execute on function public.keke_heartbeat(double precision, double precision)
  to authenticated;
grant execute on function public.keke_set_presence(text)
  to authenticated;
revoke execute on function public.keke_heartbeat(double precision, double precision)
  from anon;
revoke execute on function public.keke_set_presence(text)
  from anon;

-- ---------------------------------------------------------------------
-- 6. Realtime: in-app feed for Theo's client (insert events only)
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table public.notifications;
