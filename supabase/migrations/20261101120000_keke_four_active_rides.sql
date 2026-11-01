-- A keke carries 4 passengers: a rider may hold up to 4 active rides at once.
--
-- Before this, the dispatcher only ever offered a ride to kekes with
-- status = 'online'. Accepting flipped the rider to 'on_trip', which took
-- them out of the pool entirely — so one acceptance blocked every later ride
-- until complete-trip ran. The rider app therefore had a hard 1-trip limit
-- that no client change could lift: the gate lived in dispatch.
--
-- What changes here (and nothing else about dispatch):
--   * dispatch considers riders who are already 'on_trip', as long as they
--     are holding fewer than 4 active rides and still have a fresh heartbeat;
--   * a free rider is offered first when the other sort keys tie;
--   * accepting is refused at capacity and the ride is re-dispatched instead
--     of being silently attached to a full keke;
--   * release_keke_if_idle() sends a rider back to 'online' only when their
--     LAST active ride ends — used by complete-trip / cancel-ride /
--     refund-ride in place of the old unconditional 'on_trip' -> 'online'.
--
-- Both function bodies below are the live sources (captured 2026-11-01 over
-- the pooler) with only those edits applied, so no other dispatch rule —
-- 75s freshness, distance/queue/rating ordering, per-ride advisory locks,
-- candidate-exhaustion cancellation, DEFINER + empty search_path — moves.

-- ---------------------------------------------------------------------
-- Capacity helpers
-- ---------------------------------------------------------------------

-- Active = accepted | paid | arrived | on_trip. 'searching' never counts
-- (no rider is assigned yet) and completed / cancelled / refunded are done.
CREATE OR REPLACE FUNCTION public.keke_active_ride_count(p_keke_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path TO ''
AS $function$
  SELECT COUNT(*)::integer
  FROM public.rides r
  WHERE r.keke_id = p_keke_id
    AND r.status IN ('accepted', 'paid', 'arrived', 'on_trip');
$function$;

COMMENT ON FUNCTION public.keke_active_ride_count(uuid) IS
  'Number of rides a rider is currently carrying; 4 is the keke capacity.';

-- Called by complete-trip / cancel-ride / refund-ride after the ride leaves
-- the active set. Returns true only when the rider was actually released.
-- A rider who went offline mid-trip stays offline: releasing someone who
-- deliberately stopped working would put them back in the offer pool
-- without them asking.
CREATE OR REPLACE FUNCTION public.release_keke_if_idle(p_keke_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  IF p_keke_id IS NULL THEN
    RETURN false;
  END IF;

  -- Still carrying passengers — this trip was not their last one.
  IF public.keke_active_ride_count(p_keke_id) > 0 THEN
    RETURN false;
  END IF;

  UPDATE public.kekes k
  SET status = 'online',
      last_seen = pg_catalog.clock_timestamp()
  WHERE k.id = p_keke_id
    AND k.status = 'on_trip';

  RETURN FOUND;
END;
$function$;

COMMENT ON FUNCTION public.release_keke_if_idle(uuid) IS
  'Returns a rider to online when their last active ride ends; no-op while they still carry passengers or if they went offline.';

-- ---------------------------------------------------------------------
-- dispatch_next_ride_request — capacity-aware candidate pool
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dispatch_next_ride_request(p_ride_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_status text;
  v_assigned_keke uuid;
  v_from_id uuid;
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

  SELECT r.status::text, r.keke_id, r.from_id
  INTO v_status, v_assigned_keke, v_from_id
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
      -- 'on_trip' riders stay in the pool: a keke holds up to 4 passengers,
      -- so carrying riders can still take another booking. 'unavailable' and
      -- 'offline' remain excluded, and the heartbeat filter below still
      -- keeps a stale row from being offered work it cannot see.
      k.status IN ('online', 'on_trip')
      AND public.keke_active_ride_count(k.id) < 4
      AND k.last_seen >=
          pg_catalog.clock_timestamp() - interval '75 seconds'
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
    IF public.keke_active_ride_count(v_candidate.id) >= 4 THEN
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

  RETURN jsonb_build_object('state', 'no_ride_available');
END;
$function$;

-- ---------------------------------------------------------------------
-- respond_to_ride_request — refuse the 5th ride, keep everything else
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.respond_to_ride_request(p_request_id uuid, p_response request_response)
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

    -- Fourth seat already taken: decline this offer and hand the ride to the
    -- next eligible rider rather than attaching a 5th passenger.
    IF public.keke_active_ride_count(auth.uid()) >= 4 THEN
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

    RETURN jsonb_build_object(
      'state', 'accepted',
      'ride_id', v_ride_id
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
