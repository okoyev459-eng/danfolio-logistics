import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { isCashMethod } from '../_shared/policy.js'

// cancel-ride — student cancels their own booking.
//
// Spec (PROJECT_SPEC.md function table):
//   cancel-ride (student, ride_id): `searching`/`accepted`/`arrived` ->
//   `cancelled`, free the keke; `paid` (and any other pre-boarding status
//   with a digital payment) -> calls refund-ride.
//   Returns { status }.
//
// Rules:
//   - Caller must be the ride's own student, or a signed-in admin (admins can
//     clear stuck searching/accepted bookings; paid rides are refunded via
//     admin-refund instead).
//   - searching / accepted / arrived -> cancelled. 'arrived' means the keke
//     is at the pick-up but the student has NOT boarded. If a keke was
//     assigned, it is released back to 'online' — guarded on
//     kekes.status='on_trip' so a concurrent trip state is never clobbered.
//   - paid (and paid-arrived) -> server-to-server call to the existing
//     refund-ride function, which refunds through Paystack, marks payment +
//     ride refunded and frees the keke. This function never talks to
//     Paystack itself.
//   - on_trip / completed / cancelled / refunded -> 409, except
//     that an already-cancelled or already-refunded ride reports success so
//     retries after a dropped response are safe. An on_trip interruption is
//     rider-cancel-ride's flow, never this one.
//
// Auth: caller must be a signed-in student. Only service-role writes.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

    if (typeof rideId !== 'string' || !UUID_RE.test(rideId)) {
      return respond({ error: 'A valid ride ID is required.' }, 400)
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: ride, error: rideError } = await adminClient
      .from('rides')
      .select('id, student_id, keke_id, status, interrupted_at, interrupted_reason, fare')
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) throw rideError
    // The ride's own student, or an admin, may cancel.
    if (!ride || (ride.student_id !== user.id && !isAdmin)) {
      return respond({ error: 'Ride not found for this student.' }, 404)
    }

    async function auditEvent(event: string, metadata: Record<string, unknown>) {
      const { error } = await adminClient.from('ride_events').insert({
        ride_id: rideId,
        actor_id: user.id,
        actor_role: isAdmin && ride?.student_id !== user.id ? 'admin' : 'student',
        event,
        reason: 'student_cancelled',
        from_status: ride?.status ?? null,
        metadata,
      })
      if (error) console.error('cancel-ride: could not record event:', error)
    }

    // Retry-safe: a finished cancellation reports success.
    if (ride.status === 'cancelled') {
      return respond({ status: 'cancelled', ride_id: rideId, already_cancelled: true })
    }
    if (ride.status === 'refunded') {
      return respond({ status: 'refunded', ride_id: rideId, already_refunded: true })
    }

    // An interrupted (post-boarding) trip is never cancelled from the
    // student app: the student is or was aboard, the rider recorded a
    // breakdown, and an admin arranges the replacement. Refund decisions
    // for interrupted trips belong to admin-refund, never automatic.
    if (ride.interrupted_at && ride.status === 'on_trip') {
      return respond({
        error:
          'Your trip was interrupted and is being handled by support — a ' +
          'replacement keke is being arranged. Refund decisions for an ' +
          'interrupted trip are made by an admin, not automatically.',
        status: ride.status,
        interrupted_at: ride.interrupted_at,
        interrupted_reason: ride.interrupted_reason,
      }, 409)
    }

    // Finished rides are never cancelled from the app. This must sit BEFORE
    // the payment branch below, or a completed ride with a successful
    // payment would fall into the refund path.
    if (ride.status === 'completed') {
      return respond({
        error:
          'This booking is already completed and can no longer be cancelled.',
        status: ride.status,
      }, 409)
    }

    // Payment checked BEFORE the status branch: a paid booking that a rider
    // re-dispatched back to 'searching' (or that sits at 'accepted') must
    // still be REFUNDED, never silently cancelled without one. This is the
    // fix for the "cancelled a paid ride with no refund" bug.
    const { data: payment, error: paymentError } = await adminClient
      .from('payments')
      .select('id, status, method')
      .eq('ride_id', rideId)
      .maybeSingle()

    if (paymentError) throw paymentError

    // Legacy rows have method = NULL and were all Paystack charges, so only
    // an explicit 'cash' method is excluded from the automatic refund path.
    const digitalPaid = payment?.status === 'success' && !isCashMethod(payment.method)

    if (digitalPaid && ride.status !== 'on_trip') {
      // Server-to-server call to the existing refund-ride function. It holds
      // the Paystack logic and frees the keke itself.
      let refundResponse: Response

      try {
        refundResponse = await fetch(
          `${supabaseUrl}/functions/v1/refund-ride`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ride_id: rideId }),
            signal: AbortSignal.timeout(25000),
          },
        )
      } catch {
        console.error('cancel-ride: refund-ride could not be reached.')
        await auditEvent('refund_unconfirmed', { payment_id: payment?.id ?? null })
        return respond({
          error:
            'We could not confirm the refund request. Please try again shortly or contact support.',
        }, 502)
      }

      const refundData = await refundResponse.json().catch(() => null)

      if (!refundResponse.ok || refundData?.error) {
        await auditEvent('refund_failed', {
          payment_id: payment?.id ?? null,
          detail: refundData?.error ?? 'refund-ride returned an error',
        })
        return respond({
          error: refundData?.error || 'The refund could not be completed.',
        }, refundResponse.status >= 400 && refundResponse.status < 600 ? refundResponse.status : 502)
      }

      await auditEvent('refund_initiated', {
        payment_id: payment?.id ?? null,
        method: payment?.method ?? null,
      })

      return respond({
        status: 'refunded',
        ride_id: rideId,
        message: refundData?.message,
      })
    }

    if (payment?.status === 'success' && isCashMethod(payment.method)) {
      // Cash was collected by the rider: no Paystack refund exists to make.
      // Close the booking and tell the student exactly what happens next.
      const { data: cashClosed, error: cashCloseError } = await adminClient
        .from('rides')
        .update({ status: 'cancelled' })
        .eq('id', rideId)
        .in('status', ['searching', 'accepted', 'paid', 'arrived'])
        .select('id, status')
        .maybeSingle()

      if (cashCloseError) throw cashCloseError
      if (cashClosed) {
        await auditEvent('cancelled_cash_payment', {
          payment_id: payment.id,
          detail: 'cash refund must be settled manually with the rider',
        })
        if (ride.keke_id) {
          await adminClient.rpc('release_keke_if_idle', { p_keke_id: ride.keke_id })
        }
      }
      return respond({
        status: 'cancelled',
        ride_id: rideId,
        refund: 'manual_required',
        message:
          'Your booking is cancelled. This was a cash payment, so the ' +
          'refund must be settled directly — no Paystack refund applies.',
      })
    }

    if (ride.status === 'paid') {
      // A settled payment with an unknown/legacy method: still go through
      // refund-ride rather than cancelling a paid ride for free — it
      // re-verifies the payment server-side (and its cash guard runs first).
      let refundResponse: Response
      try {
        refundResponse = await fetch(
          `${supabaseUrl}/functions/v1/refund-ride`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ride_id: rideId }),
            signal: AbortSignal.timeout(25000),
          },
        )
      } catch {
        console.error('cancel-ride: refund-ride could not be reached.')
        return respond({
          error:
            'We could not confirm the refund request. Please try again shortly or contact support.',
        }, 502)
      }

      const refundData = await refundResponse.json().catch(() => null)

      if (!refundResponse.ok || refundData?.error) {
        return respond({
          error: refundData?.error || 'The refund could not be completed.',
        }, refundResponse.status >= 400 && refundResponse.status < 600 ? refundResponse.status : 502)
      }

      await auditEvent('refund_initiated', {
        payment_id: payment?.id ?? null,
        method: payment?.method ?? null,
        fallback: true,
      })

      return respond({
        status: 'refunded',
        ride_id: rideId,
        message: refundData?.message,
      })
    }

    // Pre-boarding statuses only. 'arrived' is included: the keke is at
    // the pick-up but the student has NOT boarded, so walking away is an
    // ordinary cancellation (a digital payment was already refunded above,
    // a cash one closed above). 'on_trip' stays refused — an aboard student
    // goes through the interruption flow, never this one.
    if (
      ride.status !== 'searching' &&
      ride.status !== 'accepted' &&
      ride.status !== 'arrived'
    ) {
      return respond({
        error:
          `This booking can no longer be cancelled from the app because its ` +
          `status is "${ride.status}". Contact support if you need help.`,
        status: ride.status,
      }, 409)
    }

    const { data: updated, error: updateError } = await adminClient
      .from('rides')
      .update({ status: 'cancelled' })
      .eq('id', rideId)
      .in('status', ['searching', 'accepted', 'arrived'])
      .select('id, status, keke_id')
      .maybeSingle()

    if (updateError) throw updateError

    if (!updated) {
      // Concurrent change — report the current state rather than guessing.
      const { data: latest } = await adminClient
        .from('rides')
        .select('status')
        .eq('id', rideId)
        .maybeSingle()

      return respond({
        error: 'The ride status changed. Please refresh and try again.',
        status: latest?.status,
      }, 409)
    }

    // Free the assigned keke — but only if this was their last active ride.
    // A keke holds up to 3 passengers, so cancelling one booking must not
    // pull a rider who is still carrying others out of their trip.
    if (updated.keke_id) {
      const { error: releaseError } = await adminClient
        .rpc('release_keke_if_idle', { p_keke_id: updated.keke_id })

      if (releaseError) {
        console.error('cancel-ride: could not release rider:', releaseError)
        return respond({
          status: 'cancelled',
          ride_id: rideId,
          warning: 'The ride is cancelled, but the rider status needs admin review.',
        })
      }
    }

    await auditEvent('booking_cancelled', {
      payment_status: payment?.status ?? 'none',
      released_keke_id: updated.keke_id ?? null,
    })

    return respond({ status: 'cancelled', ride_id: rideId })
  } catch (error) {
    console.error('cancel-ride failed:', error)
    return respond({ error: 'Could not cancel the ride. Please try again.' }, 500)
  }
})
