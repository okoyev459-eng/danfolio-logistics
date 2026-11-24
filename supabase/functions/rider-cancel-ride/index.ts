import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import {
  canArrangeReplacement,
  canInterrupt,
  canRedispatch,
  INCIDENT_REASONS,
  isCashMethod,
} from '../_shared/policy.js'

// rider-cancel-ride — how a RIDER (or an admin) reports a cancellation,
// breakdown or emergency, split honestly into the two very different
// situations the app must never confuse:
//
//   PRE-boarding  (action 'redispatch'): statuses searching / accepted /
//     paid / arrived. The student is NOT in the keke yet. The booking is
//     preserved: the assigned keke is released, the ride goes back to
//     'searching', and the EXISTING dispatch_next_ride_request() re-offers
//     it. Nothing is double-charged. Only if reassignment finds no keke at
//     all (dispatch auto-cancels) is a VERIFIED DIGITAL payment refunded,
//     through the existing refund-ride function (never here directly).
//
//   POST-boarding (action 'interrupt'): status on_trip with no interruption
//     recorded yet. The student IS in the keke. This is an INTERRUPTED
//     trip, never an ordinary cancellation: we record the interruption time
//     and the last VERIFIED GPS (ride_locations, falling back to the keke's
//     own fix; NULL if neither exists — coordinates are never invented),
//     keep status = 'on_trip' and the keke assigned so live tracking keeps
//     streaming for passenger safety, and expose the incident to the
//     student, the rider and the admin. NO automatic refund here.
//
//   'resume' (admin only): arrange the replacement keke for an interrupted
//     trip — assign mode, so the student's ride_locations RLS read and the
//     streaming feed stay intact. Refund decisions stay with refund-ride /
//     admin-refund, never automatic.
//
// Every path appends an audit row to ride_events (append-only, no client
// write policy). Auth: signed-in rider (must own the ride's keke) or
// signed-in admin. Only the service-role client writes.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Admin = ReturnType<typeof createClient>

async function recordEvent(
  admin: Admin,
  event: {
    ride_id: string
    actor_id: string | null
    actor_role: 'student' | 'rider' | 'admin' | 'system'
    event: string
    reason?: string
    from_status?: string
    to_status?: string
    metadata?: Record<string, unknown>
  },
): Promise<void> {
  const { error } = await admin.from('ride_events').insert({
    ride_id: event.ride_id,
    actor_id: event.actor_id,
    actor_role: event.actor_role,
    event: event.event,
    reason: event.reason ?? null,
    from_status: event.from_status ?? null,
    to_status: event.to_status ?? null,
    metadata: event.metadata ?? {},
  })

  // The audit trail must never turn a successful operation into a failure.
  if (error) console.error('rider-cancel-ride: could not record event:', error)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405)
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return respond({ error: 'Sign in is required.' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.error('Missing Supabase function environment configuration.')
      return respond({ error: 'Server configuration is incomplete.' }, 500)
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return respond({ error: 'Your session is invalid. Please sign in again.' }, 401)
    }

    const { data: profile, error: profileError } = await userClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) throw profileError
    const isAdmin = profile?.role === 'admin'

    const body = await req.json().catch(() => null)
    const rideId = body?.ride_id
    const action = body?.action
    const reason = body?.reason
    const targetKekeId = body?.keke_id

    if (typeof rideId !== 'string' || !UUID_RE.test(rideId)) {
      return respond({ error: 'A valid ride ID is required.' }, 400)
    }
    if (action !== 'redispatch' && action !== 'interrupt' && action !== 'resume') {
      return respond({ error: 'action must be redispatch, interrupt or resume.' }, 400)
    }
    if (reason !== undefined && !INCIDENT_REASONS.includes(reason)) {
      return respond({
        error: `reason must be one of: ${INCIDENT_REASONS.join(', ')}.`,
      }, 400)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: ride, error: rideError } = await admin
      .from('rides')
      .select(
        'id, student_id, keke_id, status, fare, mode, interrupted_at, ' +
        'interrupted_reason, interrupted_lat, interrupted_lng, ' +
        'interrupted_accuracy, replacement_at',
      )
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) throw rideError
    if (!ride) return respond({ error: 'Ride not found.' }, 404)

    // The assigned rider or an admin may act. Students cancel their own
    // bookings through cancel-ride (payment-aware), never through here.
    if (!isAdmin && ride.keke_id !== user.id) {
      return respond({ error: 'Only the assigned rider can report this.' }, 403)
    }
    const actorRole = isAdmin && ride.keke_id !== user.id ? 'admin' : 'rider'

    // ------------------------------------------------------------------
    // 'interrupt' — student is ON BOARD. Recorded, never cancelled.
    // ------------------------------------------------------------------
    if (action === 'interrupt') {
      if (!reason || reason === 'cancelled') {
        return respond({
          error: 'An on-trip interruption needs reason "breakdown" or "emergency".',
        }, 400)
      }
      if (!canInterrupt(ride.status, ride.interrupted_at)) {
        if (ride.status === 'on_trip' && ride.interrupted_at) {
          return respond({
            error: 'This trip is already recorded as interrupted.',
            status: ride.status,
            interrupted_at: ride.interrupted_at,
            interrupted_reason: ride.interrupted_reason,
            replacement_at: ride.replacement_at,
          }, 409)
        }
        return respond({
          error:
            `Only an in-progress trip (on_trip) can be interrupted; ` +
            `this ride is "${ride.status}". Use action "redispatch" ` +
            `before boarding instead.`,
          status: ride.status,
        }, 409)
      }

      // Last VERIFIED GPS: the live ride feed first, then the keke's own
      // latest fix. Never fabricated — NULL when we genuinely have none.
      let lastLat: number | null = null
      let lastLng: number | null = null
      let lastAccuracy: number | null = null
      let gpsSource = 'none'

      const { data: loc, error: locError } = await admin
        .from('ride_locations')
        .select('lat, lng, accuracy, updated_at')
        .eq('ride_id', rideId)
        .maybeSingle()

      if (locError) throw locError

      if (loc) {
        lastLat = loc.lat
        lastLng = loc.lng
        lastAccuracy = loc.accuracy ?? null
        gpsSource = 'ride_locations'
      } else if (ride.keke_id) {
        const { data: keke, error: kekeError } = await admin
          .from('kekes')
          .select('lat, lng, last_seen')
          .eq('id', ride.keke_id)
          .maybeSingle()

        if (kekeError) throw kekeError
        if (keke && keke.lat !== null && keke.lng !== null) {
          lastLat = keke.lat
          lastLng = keke.lng
          lastAccuracy = null
          gpsSource = 'keke_last_fix'
        }
      }

      const interruptedAt = new Date().toISOString()

      const { data: updated, error: updateError } = await admin
        .from('rides')
        .update({
          interrupted_at: interruptedAt,
          interrupted_reason: reason,
          interrupted_lat: lastLat,
          interrupted_lng: lastLng,
          interrupted_accuracy: lastAccuracy,
        })
        .eq('id', rideId)
        .eq('status', 'on_trip')
        .is('interrupted_at', null)
        .select('id, status, keke_id')
        .maybeSingle()

      if (updateError) throw updateError
      if (!updated) {
        return respond({
          error: 'The trip changed state. Please refresh and try again.',
        }, 409)
      }

      // No refund, no release: the student is still aboard and the tracking
      // feed must keep streaming (keke_id and status stay untouched).
      await recordEvent(admin, {
        ride_id: rideId,
        actor_id: user.id,
        actor_role: actorRole,
        event: 'trip_interrupted',
        reason,
        from_status: 'on_trip',
        to_status: 'on_trip',
        metadata: {
          interrupted_at: interruptedAt,
          gps: { lat: lastLat, lng: lastLng, accuracy: lastAccuracy, source: gpsSource },
          passenger_on_board: true,
        },
      })

      return respond({
        status: 'on_trip',
        interrupted: true,
        interrupted_at: interruptedAt,
        interrupted_reason: reason,
        last_gps: lastLat !== null && lastLng !== null
          ? { lat: lastLat, lng: lastLng, accuracy: lastAccuracy, source: gpsSource }
          : null,
        refund: 'not_applicable',
        message:
          'Trip interruption recorded. The student has been notified and ' +
          'an admin can now arrange a replacement keke. Your live location ' +
          'keeps streaming so the student stays visible.',
      })
    }

    // ------------------------------------------------------------------
    // 'resume' — ADMIN arranges the replacement keke (assign mode).
    // ------------------------------------------------------------------
    if (action === 'resume') {
      if (!isAdmin) {
        return respond({ error: 'Only an admin can arrange a replacement.' }, 403)
      }
      if (!canArrangeReplacement(ride.interrupted_at, ride.replacement_at)) {
        return respond({
          error: ride.replacement_at
            ? 'A replacement has already been arranged for this trip.'
            : 'This trip is not interrupted.',
          interrupted_at: ride.interrupted_at,
          replacement_at: ride.replacement_at,
        }, 409)
      }
      if (typeof targetKekeId !== 'string' || !UUID_RE.test(targetKekeId)) {
        return respond({ error: 'A valid replacement keke ID (keke_id) is required.' }, 400)
      }

      const { data: replacement, error: replacementError } = await admin
        .from('kekes')
        .select('id, status, last_seen')
        .eq('id', targetKekeId)
        .maybeSingle()

      if (replacementError) throw replacementError
      if (!replacement) return respond({ error: 'Replacement keke not found.' }, 404)

      // Same eligibility spirit as dispatch: available, fresh heartbeat,
      // under capacity. Deliberately NOT a dispatch call — the RPC requires
      // status='searching', and clearing keke_id would break the student's
      // ride_locations read while they are still aboard.
      const { data: capacity, error: capacityError } = await admin.rpc(
        'keke_active_ride_count',
        { p_keke_id: targetKekeId },
      )
      if (capacityError) throw capacityError
      if (Number(capacity) >= 3) {
        return respond({ error: 'That keke already carries 3 passengers.' }, 409)
      }
      if (!['online', 'on_trip'].includes(replacement.status)) {
        return respond({
          error: `That keke is "${replacement.status}", not available for a pickup.`,
        }, 409)
      }
      const fresh = replacement.last_seen &&
        Date.now() - new Date(replacement.last_seen).getTime() < 75_000
      if (!fresh) {
        return respond({ error: 'That keke has no fresh location heartbeat.' }, 409)
      }

      const replacementAt = new Date().toISOString()

      const { data: swapped, error: swapError } = await admin
        .from('rides')
        .update({ keke_id: targetKekeId, replacement_at: replacementAt })
        .eq('id', rideId)
        .eq('status', 'on_trip')
        .not('interrupted_at', 'is', null)
        .is('replacement_at', null)
        .select('id, keke_id')
        .maybeSingle()

      if (swapError) throw swapError
      if (!swapped) {
        return respond({ error: 'The trip changed state. Please refresh.' }, 409)
      }

      // Keep the tracking row pointing at the replacement keke so the
      // student's map and the publish RLS both follow the new driver.
      const { error: locError } = await admin
        .from('ride_locations')
        .update({ keke_id: targetKekeId })
        .eq('ride_id', rideId)

      if (locError) {
        // The row may not exist yet (no fix published). Not fatal.
        console.error('rider-cancel-ride: ride_locations keke swap failed:', locError)
      }

      // The replaced keke only goes back to 'online' if this was their last
      // active ride (and only if they were 'on_trip').
      if (ride.keke_id && ride.keke_id !== targetKekeId) {
        const { error: releaseError } = await admin.rpc('release_keke_if_idle', {
          p_keke_id: ride.keke_id,
        })
        if (releaseError) {
          console.error('rider-cancel-ride: could not release old keke:', releaseError)
        }
      }

      await recordEvent(admin, {
        ride_id: rideId,
        actor_id: user.id,
        actor_role: 'admin',
        event: 'replacement_assigned',
        from_status: ride.status,
        to_status: ride.status,
        metadata: {
          from_keke_id: ride.keke_id,
          to_keke_id: targetKekeId,
          interrupted_at: ride.interrupted_at,
          replacement_at: replacementAt,
        },
      })

      return respond({
        status: ride.status,
        replacement_keke_id: targetKekeId,
        replacement_at: replacementAt,
        interrupted_at: ride.interrupted_at,
        message: 'Replacement keke assigned; the trip continues with live tracking.',
      })
    }

    // ------------------------------------------------------------------
    // 'redispatch' — BEFORE boarding. Booking + payment preserved.
    // ------------------------------------------------------------------
    if (!reason) {
      return respond({ error: 'A reason is required: cancelled, breakdown or emergency.' }, 400)
    }
    if (!canRedispatch(ride.status)) {
      if (ride.status === 'on_trip') {
        return respond({
          error:
            'The student has already boarded. Use action "interrupt" to ' +
            'record the breakdown — a trip in progress is never cancelled ' +
            'automatically.',
          status: ride.status,
        }, 409)
      }
      if (ride.status === 'cancelled' || ride.status === 'refunded') {
        return respond({ status: ride.status, already_closed: true })
      }
      return respond({
        error: `This ride (status "${ride.status}") can no longer be re-dispatched.`,
        status: ride.status,
      }, 409)
    }

    // Snapshot who was assigned BEFORE we clear it.
    const previousKekeId = ride.keke_id

    // Release the keke first: guarded update, keke_id cleared, status back
    // to 'searching'. Payment rows are untouched — nothing is charged again.
    const { data: reset, error: resetError } = await admin
      .from('rides')
      .update({ status: 'searching', keke_id: null })
      .eq('id', rideId)
      .in('status', ['searching', 'accepted', 'paid', 'arrived'])
      .select('id, status, keke_id, fare')
      .maybeSingle()

    if (resetError) throw resetError
    if (!reset) {
      const { data: latest } = await admin
        .from('rides')
        .select('status')
        .eq('id', rideId)
        .maybeSingle()
      return respond({
        error: 'The ride status changed. Please refresh and try again.',
        status: latest?.status,
      }, 409)
    }

    if (previousKekeId) {
      const { error: releaseError } = await admin.rpc('release_keke_if_idle', {
        p_keke_id: previousKekeId,
      })
      if (releaseError) {
        console.error('rider-cancel-ride: could not release keke:', releaseError)
      }
    }

    await recordEvent(admin, {
      ride_id: rideId,
      actor_id: user.id,
      actor_role: actorRole,
      event: 'redispatch_requested',
      reason,
      from_status: ride.status,
      to_status: 'searching',
      metadata: {
        previous_keke_id: previousKekeId,
        fare: ride.fare,
        payment_preserved: true,
        student_has_boarded: false,
      },
    })

    // Hand the booking back to the EXISTING dispatcher. On success the ride
    // is offered again (and accept flips it straight back to 'paid' when the
    // payment already succeeded — see respond_to_ride_request).
    const { data: dispatch, error: dispatchError } = await admin.rpc(
      'dispatch_next_ride_request',
      { p_ride_id: rideId },
    )

    if (dispatchError) {
      console.error('rider-cancel-ride: dispatch failed:', dispatchError)
      return respond({
        status: 'searching',
        ride_id: rideId,
        warning: 'The booking was released but re-dispatch needs a retry.',
      }, 202)
    }

    if (dispatch?.state === 'offered') {
      return respond({
        status: 'searching',
        ride_id: rideId,
        dispatch_state: 'offered',
        payment: 'preserved',
        message: 'Booking released and re-offered to another keke.',
      })
    }

    // dispatch_next_ride_request auto-cancelled the ride: no eligible keke.
    // NOW — and only now — a verified DIGITAL payment is refunded, through
    // the existing refund-ride function (server-to-server, Paystack logic
    // stays in one place). Cash is never sent to Paystack.
    const { data: payment, error: paymentError } = await admin
      .from('payments')
      .select('id, status, method')
      .eq('ride_id', rideId)
      .maybeSingle()

    if (paymentError) throw paymentError

    if (payment?.status !== 'success') {
      await recordEvent(admin, {
        ride_id: rideId,
        actor_id: user.id,
        actor_role: actorRole,
        event: 'reassignment_failed',
        reason,
        to_status: 'cancelled',
        metadata: {
          payment_status: payment?.status ?? 'none',
          refund: 'not_needed',
        },
      })
      return respond({
        status: 'cancelled',
        ride_id: rideId,
        dispatch_state: dispatch?.state ?? 'no_ride_available',
        refund: 'not_needed',
        message: 'No keke was available, so the booking was closed. No payment had settled.',
      })
    }

    if (isCashMethod(payment.method)) {
      // A cash payment never reached Paystack — refunding it is an admin /
      // manual action, recorded here so the history is complete.
      await recordEvent(admin, {
        ride_id: rideId,
        actor_id: user.id,
        actor_role: actorRole,
        event: 'reassignment_failed',
        reason,
        to_status: 'cancelled',
        metadata: {
          payment_status: payment.status,
          payment_method: payment.method ?? 'unknown',
          refund: 'manual_required',
        },
      })
      return respond({
        status: 'cancelled',
        ride_id: rideId,
        refund: 'manual_required',
        message:
          'The booking was closed. This was a cash payment, so a refund ' +
          'must be arranged by an admin — no Paystack refund was attempted.',
      })
    }

    // Server-to-server call to the existing refund-ride function.
    let refundResponse: Response
    try {
      refundResponse = await fetch(`${supabaseUrl}/functions/v1/refund-ride`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ride_id: rideId }),
        signal: AbortSignal.timeout(25000),
      })
    } catch {
      console.error('rider-cancel-ride: refund-ride could not be reached.')
      await recordEvent(admin, {
        ride_id: rideId,
        actor_id: user.id,
        actor_role: actorRole,
        event: 'refund_unconfirmed',
        reason,
        metadata: { payment_id: payment.id, next: 'manual_review' },
      })
      return respond({
        status: 'cancelled',
        ride_id: rideId,
        refund: 'unconfirmed',
        error:
          'The booking was closed, but the refund could not be confirmed. ' +
          'Please contact support — it will never be retried blindly.',
      }, 502)
    }

    const refundData = await refundResponse.json().catch(() => null)

    if (!refundResponse.ok || refundData?.error) {
      await recordEvent(admin, {
        ride_id: rideId,
        actor_id: user.id,
        actor_role: actorRole,
        event: 'refund_failed',
        reason,
        metadata: {
          payment_id: payment.id,
          detail: refundData?.error ?? 'refund-ride returned an error',
        },
      })
      return respond({
        status: 'cancelled',
        ride_id: rideId,
        refund: 'failed',
        error: refundData?.error || 'The refund could not be completed.',
      }, 502)
    }

    await recordEvent(admin, {
      ride_id: rideId,
      actor_id: user.id,
      actor_role: actorRole,
      event: 'refund_initiated',
      reason,
      to_status: 'refunded',
      metadata: { payment_id: payment.id, method: payment.method },
    })

    return respond({
      status: refundData?.status ?? 'refunded',
      ride_id: rideId,
      refund: 'initiated',
      message: refundData?.message,
    })
  } catch (error) {
    console.error('rider-cancel-ride failed:', error)
    return respond({ error: 'Could not process the request. Please try again.' }, 500)
  }
})
