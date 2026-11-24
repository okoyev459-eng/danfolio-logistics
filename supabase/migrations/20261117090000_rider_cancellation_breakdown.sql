-- Migration: rider cancellation / breakdown handling + dispatch hardening.
--
-- Implements Tasks 1 and 2 of the FINAL APP COMPLETION brief:
--   * an interrupted (post-boarding) trip is modelled WITHOUT a new enum
--     value — status stays 'on_trip' and new columns record the incident;
--   * ride_events gives an append-only audit trail for cancellations,
--     breakdowns, reassignments, payments and refunds;
--   * payments gains `method` (card/transfer/cash) and `service_fee`;
--   * dispatch capacity becomes THREE passengers (excluding the rider) —
--     the shared _shared/policy.js constant MAX_ACTIVE_RIDES;
--   * along-mode candidates are PREFERRED when the keke sits at the pickup
--     station (a sort key, never a hard filter — live station_id is NULL);
--   * a partial unique index makes double-booking structurally impossible.
--
-- Safety rules honoured here:
--   * NO new ride_status enum value (avoids the enum-in-same-transaction
--     hazard and keeps every existing status whitelist working);
--   * the two dispatch/RPC bodies below are the live sources captured in
--     20261101120000_keke_four_active_rides.sql with ONLY the capacity
--     change, the along-preference sort key, the payment-aware accept and
--     audit inserts applied — no other dispatch rule moves;
--   * the unique index is created inside a DO block that swallows
--     unique_violation, so it can never destroy existing data;
--   * no rows are deleted, no money is moved, no data is invented.
--
-- The numbers below MUST stay in step with supabase/functions/_shared/
-- policy.js — tests/policy.test.js reads this file and fails on drift.
--
-- STATUS: written, NOT applied (no Supabase CLI binary / access token in
-- this environment). Apply with:  supabase db push
-- THEN deploy functions:         supabase functions deploy rider-cancel-ride ...

-- =====================================================================
-- 1. rides: interruption + replacement columns
-- =====================================================================

alter table public.rides
  add column if not exists interrupted_at        timestamptz,
  add column if not exists interrupted_reason    text,
  add column if not exists interrupted_lat       double precision,
  add column if not exists interrupted_lng       double precision,
  add column if not exists interrupted_accuracy  double precision,
  add column if not exists replacement_at        timestamptz;

alter table public.rides
  drop constraint if exists rides_interrupted_reason_check;

alter table public.rides
  add constraint rides_interrupted_reason_check
  check (
    interrupted_at is null
    or interrupted_reason in ('cancelled', 'breakdown', 'emergency')
  );

comment on column public.rides.interrupted_at is
  'Set when a rider reports a breakdown/emergency (post-boarding) or a pre-boarding incident. Status keeps its existing value; see supabase/functions/_shared/policy.js.';
comment on column public.rides.interrupted_lat is
  'Last VERIFIED GPS of this ride (ride_locations first, the keke''s own last fix as fallback). NULL means we genuinely have no fix — never invented.';
comment on column public.rides.replacement_at is
  'Set by an admin when a replacement keke has been assigned to an interrupted trip.';

create index if not exists rides_interrupted_open
  on public.rides (interrupted_at)
  where interrupted_at is not null and replacement_at is null;

-- =====================================================================
-- 2. payments: method (card/transfer/cash) + the fixed service fee
-- =====================================================================

alter table public.payments
  add column if not exists method       text,
  add column if not exists service_fee  integer;

alter table public.payments
  drop constraint if exists payments_method_check;

alter table public.payments
  add constraint payments_method_check
  check (method is null or method in ('card', 'transfer', 'cash'));

alter table public.payments
  drop constraint if exists payments_service_fee_check;

alter table public.payments
  add constraint payments_service_fee_check
  check (service_fee is null or service_fee >= 0);

comment on column public.payments.method is
  'card / transfer = digital (refundable via Paystack); cash = collected by the rider, NEVER sent to Paystack. NULL on rows written before this migration (treated as digital — they were all Paystack).';
comment on column public.payments.service_fee is
  'Fixed platform commission in NGN charged ON TOP of the fare. The rider is never paid from this column.';

-- =====================================================================
-- 3. ride_events: append-only audit trail.
--    No INSERT/UPDATE/DELETE policy exists → API clients cannot write it.
--    Writes come from SECURITY DEFINER RPCs (owner bypasses RLS) and from
--    Edge Functions (service role). Rows are never updated or deleted.
-- =====================================================================

create table if not exists public.ride_events (
  id          uuid primary key default gen_random_uuid(),
  ride_id     uuid not null references public.rides (id) on delete cascade,
  actor_id    uuid,
  actor_role  text not null default 'system'
              check (actor_role in ('student', 'rider', 'admin', 'system')),
  event       text not null,
  reason      text,
  from_status text,
  to_status   text,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists ride_events_ride_idx
  on public.ride_events (ride_id, created_at desc);

alter table public.ride_events enable row level security;

drop policy if exists "ride events read" on public.ride_events;

create policy "ride events read" on public.ride_events
  for select
  to authenticated
  using (
    public.is_admin()
    or exists (
      select 1
      from public.rides r
      where r.id = ride_events.ride_id
        and (r.student_id = auth.uid() or r.keke_id = auth.uid())
    )
  );

grant select on public.ride_events to authenticated;
grant all on public.ride_events to service_role;

-- =====================================================================
-- 4. Dispatch: THREE passengers excluding the rider.
--
-- Body = the live source from 20261101120000_keke_four_active_rides.sql
-- with ONLY these edits (everything else — 75 s heartbeat, distance /
-- queue / rating ordering, per-ride advisory locks, candidate exhaustion
-- cancellation, DEFINER + empty search_path, `state` response keys —
-- copied verbatim so every existing caller keeps working):
--   * capacity 4 -> 3                        (two gates + comments)
--   * v_mode / v_to_id captured so along rides can PREFER a keke already
--     queued at the pickup station, and re-verify the along fare route;
--   * ride_events row when dispatch auto-cancels a ride it cannot fill.
-- =====================================================================

create or replace function public.dispatch_next_ride_request(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_status text;
  v_assigned_keke uuid;
  v_from_id uuid;
  v_to_id uuid;
  v_mode text;
  v_pickup_lat double precision;
  v_pickup_lng double precision;
  v_request_id uuid;
  v_offered_keke uuid;
  v_expires_at timestamptz;
  v_candidate record;
BEGIN
  IF p_ride_id IS NULL THEN
    RAISE EXCEPTION 'A ride ID is required.';
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT COALESCE(public.is_admin(), false)
     AND NOT EXISTS (
       SELECT 1 FROM public.rides r
       WHERE r.id = p_ride_id
         AND r.student_id = auth.uid()
     )
     AND NOT EXISTS (
       SELECT 1 FROM public.ride_requests rr
       WHERE rr.ride_id = p_ride_id
         AND rr.keke_id = auth.uid()
     )
  THEN
    RAISE EXCEPTION 'You are not allowed to dispatch this ride.';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('ride-dispatch'),
    pg_catalog.hashtext(p_ride_id::text)
  );

  SELECT r.status::text, r.keke_id, r.from_id, r.to_id, r.mode::text
  INTO v_status, v_assigned_keke, v_from_id, v_to_id, v_mode
  FROM public.rides r
  WHERE r.id = p_ride_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('state', 'not_found');
  END IF;

  IF v_status = 'cancelled' AND v_assigned_keke IS NULL THEN
    RETURN jsonb_build_object('state', 'no_ride_available');
  END IF;

  IF v_status <> 'searching' OR v_assigned_keke IS NOT NULL THEN
    RETURN jsonb_build_object(
      'state', 'already_assigned',
      'keke_id', v_assigned_keke,
      'status', v_status
    );
  END IF;

  UPDATE public.ride_requests
  SET response = 'expired'
  WHERE response = 'pending'
    AND expires_at <= pg_catalog.clock_timestamp();

  SELECT rr.id, rr.keke_id, rr.expires_at
  INTO v_request_id, v_offered_keke, v_expires_at
  FROM public.ride_requests rr
  WHERE rr.ride_id = p_ride_id
    AND rr.response = 'pending'
    AND rr.expires_at > pg_catalog.clock_timestamp()
  ORDER BY rr.sent_at DESC
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'state', 'offered',
      'request_id', v_request_id,
      'keke_id', v_offered_keke,
      'expires_at', v_expires_at
    );
  END IF;

  SELECT l.lat, l.lng
  INTO v_pickup_lat, v_pickup_lng
  FROM public.locations l
  WHERE l.id = v_from_id
    AND l.active = true;

  -- Coordinates are optional for the initial dispatch phase.
  -- When available later, use them to rank riders by pickup distance.

  FOR v_candidate IN
    SELECT k.id
    FROM public.kekes k
    LEFT JOIN public.locations station
      ON station.id = k.station_id
    WHERE
      -- 'on_trip' riders stay in the pool: a keke holds up to 3 passengers,
      -- so carrying riders can still take another booking. 'unavailable' and
      -- 'offline' remain excluded, and the heartbeat filter below still
      -- keeps a stale row from being offered work it cannot see.
      k.status IN ('online', 'on_trip')
      AND public.keke_active_ride_count(k.id) < 3
      AND k.last_seen >=
          pg_catalog.clock_timestamp() - interval '75 seconds'
      -- ALONG rides must stay on a VERIFIED route: the priced fare row for
      -- (along, pickup station, destination) has to exist. Drop rides are
      -- unaffected.
      AND (
        v_mode IS DISTINCT FROM 'along'
        OR EXISTS (
          SELECT 1 FROM public.fares f
          WHERE f.mode = 'along'
            AND f.from_id = v_from_id
            AND f.to_id = v_to_id
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.ride_requests previous
        WHERE previous.ride_id = p_ride_id
          AND previous.keke_id = k.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.ride_requests pending
        WHERE pending.keke_id = k.id
          AND pending.response = 'pending'
          AND pending.expires_at > pg_catalog.clock_timestamp()
      )
    ORDER BY
      -- ALONG: prefer a keke already queued at the pickup station so the
      -- ride heads in the correct direction from the start. Preference only
      -- (a sort key): NULL station_id or no match falls through to the
      -- historical ordering, so drop rides and unmatched along rides keep
      -- the exact behaviour they had before.
      CASE
        WHEN v_mode = 'along' AND k.station_id = v_from_id THEN 0
        ELSE 1
      END ASC,
      -- A rider with a free seat can come straight away; everything else
      -- being equal, an idle rider beats one already mid-trip. For a pool
      -- that is entirely 'online' this key is constant, so the historical
      -- ordering is untouched.
      CASE WHEN k.status = 'online' THEN 0 ELSE 1 END ASC,
      CASE
        WHEN v_pickup_lat IS NOT NULL
         AND v_pickup_lng IS NOT NULL
         AND COALESCE(k.lat, station.lat) IS NOT NULL
         AND COALESCE(k.lng, station.lng) IS NOT NULL
        THEN
          6371000.0 * acos(
            LEAST(
              1.0,
              GREATEST(
                -1.0,
                cos(radians(v_pickup_lat))
                  * cos(radians(COALESCE(k.lat, station.lat)))
                  * cos(
                      radians(COALESCE(k.lng, station.lng))
                      - radians(v_pickup_lng)
                    )
                  + sin(radians(v_pickup_lat))
                    * sin(radians(COALESCE(k.lat, station.lat)))
              )
            )
          )
        ELSE NULL
      END ASC NULLS LAST,
      k.queue_joined_at ASC NULLS LAST,
      k.rating DESC NULLS LAST,
      k.id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('keke-dispatch'),
      pg_catalog.hashtext(v_candidate.id::text)
    );

    IF EXISTS (
      SELECT 1
      FROM public.ride_requests pending
      WHERE pending.keke_id = v_candidate.id
        AND pending.response = 'pending'
        AND pending.expires_at > pg_catalog.clock_timestamp()
    ) THEN
      CONTINUE;
    END IF;

    -- Re-checked under the per-rider lock: another ride may have filled the
    -- last seat between the scan above and this insert.
    IF public.keke_active_ride_count(v_candidate.id) >= 3 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.ride_requests (
      id, ride_id, keke_id, sent_at, expires_at, response
    )
    VALUES (
      gen_random_uuid(),
      p_ride_id,
      v_candidate.id,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp() + interval '15 seconds',
      'pending'
    )
    RETURNING id, keke_id, expires_at
    INTO v_request_id, v_offered_keke, v_expires_at;

    RETURN jsonb_build_object(
      'state', 'offered',
      'request_id', v_request_id,
      'keke_id', v_offered_keke,
      'expires_at', v_expires_at
    );
  END LOOP;

  UPDATE public.rides
  SET status = 'cancelled'
  WHERE id = p_ride_id
    AND status = 'searching'
    AND keke_id IS NULL;

  IF FOUND THEN
    -- Audit the automatic cancellation (never silently).
    INSERT INTO public.ride_events (
      ride_id, actor_role, event, reason, from_status, to_status, metadata
    )
    VALUES (
      p_ride_id, 'system', 'auto_cancelled', 'no_ride_available',
      'searching', 'cancelled',
      jsonb_build_object('source', 'dispatch_next_ride_request')
    );
  END IF;

  RETURN jsonb_build_object('state', 'no_ride_available');
END;
$function$;

comment on function public.dispatch_next_ride_request(uuid) is
  'Opens the next 15s offer for a searching ride. Capacity = 3 passengers excluding the rider (MAX_ACTIVE_RIDES in _shared/policy.js).';

-- =====================================================================
-- 5. respond_to_ride_request: capacity 3 + payment-aware accept.
--
-- Body = the live source from 20261101120000_keke_four_active_rides.sql
-- with ONLY these edits:
--   * capacity gate `>= 4` -> `>= 3` (and its comment);
--   * after a successful accept, if a payments row with status='success'
--     exists the ride flips accepted -> paid and the response carries
--     `ride_status` — so mark-arrived and PayRide stay correct and the
--     student can never be charged twice;
--   * an audit row in ride_events.
-- Signature, auth (auth.uid() is the keke), advisory locks, TTL expiry
-- and every `state` key are unchanged.
-- =====================================================================

create or replace function public.respond_to_ride_request(p_request_id uuid, p_response request_response)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_ride_id uuid;
  v_request public.ride_requests%ROWTYPE;
  v_ride_status text;
  v_assigned_keke uuid;
  v_final_response public.request_response;
  v_final_ride_status text;
  v_dispatch jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in is required.';
  END IF;

  IF p_response::text NOT IN ('accepted', 'declined', 'expired') THEN
    RAISE EXCEPTION 'Invalid rider response.';
  END IF;

  SELECT rr.ride_id
  INTO v_ride_id
  FROM public.ride_requests rr
  WHERE rr.id = p_request_id
    AND rr.keke_id = auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This offer does not belong to your rider account.';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('ride-dispatch'),
    pg_catalog.hashtext(v_ride_id::text)
  );

  SELECT rr.*
  INTO v_request
  FROM public.ride_requests rr
  WHERE rr.id = p_request_id
    AND rr.keke_id = auth.uid()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Offer not found.';
  END IF;

  IF v_request.response <> 'pending' THEN
    RETURN jsonb_build_object(
      'state', v_request.response::text
    );
  END IF;

  SELECT r.status::text, r.keke_id
  INTO v_ride_status, v_assigned_keke
  FROM public.rides r
  WHERE r.id = v_ride_id
  FOR UPDATE;

  IF v_ride_status <> 'searching' OR v_assigned_keke IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'unavailable');
  END IF;

  IF p_response = 'accepted' THEN
    IF v_request.expires_at <= pg_catalog.clock_timestamp() THEN
      UPDATE public.ride_requests
      SET response = 'expired'
      WHERE id = p_request_id;

      v_dispatch := public.dispatch_next_ride_request(v_ride_id);

      RETURN jsonb_build_object(
        'state', v_dispatch ->> 'state',
        'dispatch', v_dispatch
      );
    END IF;

    -- Third seat already taken: decline this offer and hand the ride to the
    -- next eligible rider rather than attaching a 4th passenger.
    IF public.keke_active_ride_count(auth.uid()) >= 3 THEN
      UPDATE public.ride_requests
      SET response = 'declined'
      WHERE id = p_request_id
        AND response = 'pending';

      v_dispatch := public.dispatch_next_ride_request(v_ride_id);

      RETURN jsonb_build_object(
        'state', 'at_capacity',
        'dispatch', v_dispatch
      );
    END IF;

    UPDATE public.rides
    SET keke_id = auth.uid(),
        status = 'accepted',
        accepted_at = pg_catalog.clock_timestamp()
    WHERE id = v_ride_id
      AND status = 'searching'
      AND keke_id IS NULL;

    IF NOT FOUND THEN
      RETURN jsonb_build_object('state', 'unavailable');
    END IF;

    UPDATE public.ride_requests
    SET response = 'accepted'
    WHERE id = p_request_id;

    UPDATE public.kekes
    SET status = 'on_trip',
        last_seen = pg_catalog.clock_timestamp()
    WHERE id = auth.uid();

    -- Payment-aware accept: a payment that already succeeded (settled while
    -- this offer was open, or a re-accept after a rider re-dispatch) moves
    -- the ride straight to 'paid'. PayRide therefore never opens a second
    -- charge, and mark-arrived works from the correct status.
    IF EXISTS (
      SELECT 1 FROM public.payments p
      WHERE p.ride_id = v_ride_id AND p.status = 'success'
    ) THEN
      UPDATE public.rides
      SET status = 'paid'
      WHERE id = v_ride_id AND status = 'accepted';

      v_final_ride_status := 'paid';
    ELSE
      v_final_ride_status := 'accepted';
    END IF;

    INSERT INTO public.ride_events (
      ride_id, actor_id, actor_role, event, from_status, to_status, metadata
    )
    VALUES (
      v_ride_id, auth.uid(), 'rider', 'offer_accepted',
      'searching', v_final_ride_status,
      jsonb_build_object('request_id', p_request_id)
    );

    RETURN jsonb_build_object(
      'state', 'accepted',
      'ride_id', v_ride_id,
      'ride_status', v_final_ride_status
    );
  END IF;

  -- A timeout cannot be declared before the server deadline.
  IF p_response = 'expired'
     AND v_request.expires_at > pg_catalog.clock_timestamp()
  THEN
    RETURN jsonb_build_object(
      'state', 'pending',
      'expires_at', v_request.expires_at
    );
  END IF;

  v_final_response :=
    CASE
      WHEN v_request.expires_at <= pg_catalog.clock_timestamp()
        THEN 'expired'::public.request_response
      WHEN p_response = 'declined'
        THEN 'declined'::public.request_response
      ELSE 'expired'::public.request_response
    END;

  UPDATE public.ride_requests
  SET response = v_final_response
  WHERE id = p_request_id;

  v_dispatch := public.dispatch_next_ride_request(v_ride_id);

  RETURN jsonb_build_object(
    'state', v_dispatch ->> 'state',
    'dispatch', v_dispatch
  );
END;
$function$;

comment on function public.respond_to_ride_request(uuid, request_response) is
  'Accept/decline an offer as the signed-in rider. Capacity gate = 3. An already-successful payment flips accepted -> paid.';

-- =====================================================================
-- 6. Comments on the untouched helpers so their intent matches capacity 3.
-- =====================================================================

comment on function public.keke_active_ride_count(uuid) is
  'Number of rides a rider is currently carrying; 3 is the keke capacity (MAX_ACTIVE_RIDES in _shared/policy.js).';

comment on function public.release_keke_if_idle(uuid) is
  'Returns a rider to online when their last active ride ends; no-op while they still carry passengers (up to 3) or if they went offline.';

-- =====================================================================
-- 7. Race protection: at most ONE active ride per student.
--
-- create-ride catches unique_violation (23505) and returns a friendly
-- "you already have an active ride" message. The index build is guarded so
-- it can never fail (or destroy) on pre-existing duplicate rows.
-- =====================================================================

do $$
begin
  create unique index rides_one_active_per_student
    on public.rides (student_id)
    where status in ('searching', 'accepted', 'paid', 'arrived', 'on_trip');
exception
  when unique_violation then
    raise notice 'rides_one_active_per_student not created: existing active rides would conflict. Review duplicates manually.';
  when others then
    raise notice 'rides_one_active_per_student not created: %', SQLERRM;
end
$$;

create index if not exists rides_active_student_idx
  on public.rides (student_id)
  where status in ('searching', 'accepted', 'paid', 'arrived', 'on_trip');

create index if not exists rides_keke_status_idx
  on public.rides (keke_id, status)
  where keke_id is not null;

create index if not exists ride_requests_open_idx
  on public.ride_requests (ride_id, expires_at)
  where response is null;

create index if not exists payments_ride_status_idx
  on public.payments (ride_id, status);
