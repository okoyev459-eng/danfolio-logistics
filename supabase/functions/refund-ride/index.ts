import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { isCashMethod } from '../_shared/policy.js'

// refund-ride — server-to-server refund of a VERIFIED payment.
//
// Guard rails (Task 1):
//   * only a payment with status 'success' can ever be refunded, and only
//     through Paystack when the method is digital (card/transfer). A CASH
//     payment never reached Paystack — it returns 409 so no system or
//     student path can silently "refund" money that was never charged;
//   * ride statuses: paid / arrived always; searching / accepted / cancelled
//     / refunded when a successful payment exists (a paid booking that was
//     re-dispatched back to 'searching', then closed with no keke);
//   * on_trip ONLY when the trip is recorded as interrupted
//     (interrupted_at IS NOT NULL) — that is an admin-decided refund of a
//     breakdown, never an automatic one;
//   * completed is never automatically refundable;
//   * retry-safe: an already-refunded pair reports success without calling
//     Paystack again (no duplicate refunds).

const corsHeaders = {
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
}

Deno.serve(async (req) => {
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed.' }, 405)
  }

  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY')

    // Only trusted server functions may initiate refunds.
    if (
      !serviceKey ||
      req.headers.get('Authorization') !== `Bearer ${serviceKey}`
    ) {
      return respond({ error: 'Server authorization required.' }, 401)
    }

    if (!supabaseUrl || !paystackSecret) {
      return respond({ error: 'Refund service is not configured.' }, 500)
    }

    let body: { ride_id?: string }

    try {
      body = await req.json()
    } catch {
      return respond({ error: 'Invalid request body.' }, 400)
    }

    const rideId = body?.ride_id

    if (
      typeof rideId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rideId)
    ) {
      return respond({ error: 'A valid ride ID is required.' }, 400)
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: ride, error: rideError } = await admin
      .from('rides')
      .select('id, keke_id, status, interrupted_at')
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) throw rideError
    if (!ride) return respond({ error: 'Ride not found.' }, 404)

    const { data: payment, error: paymentError } = await admin
      .from('payments')
      .select('id, paystack_ref, amount, status, method')
      .eq('ride_id', rideId)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) {
      return respond({ error: 'No payment record exists for this ride.' }, 404)
    }

    async function auditEvent(event: string, metadata: Record<string, unknown>) {
      const { error } = await admin.from('ride_events').insert({
        ride_id: rideId,
        actor_role: 'system',
        event,
        from_status: ride.status,
        metadata,
      })
      if (error) console.error('refund-ride: could not record event:', error)
    }

    if (ride.status === 'refunded' && payment.status === 'refunded') {
      // Retry-safe cleanup if an earlier attempt did not release the rider.
      if (ride.keke_id) {
        const { error } = await admin.rpc('release_keke_if_idle', {
          p_keke_id: ride.keke_id,
        })

        if (error) throw error
      }

      return respond({
        status: 'refunded',
        ride_id: rideId,
        already_refunded: true,
      })
    }

    // Which ride statuses may be refunded, given this payment actually
    // moved money. 'completed' is deliberately absent: a finished trip is
    // settled, and 'on_trip' is only reachable when an interruption was
    // recorded (admin-decided, never automatic).
    const refundableStatuses = ['paid', 'arrived', 'searching', 'accepted', 'cancelled', 'refunded']
    if (ride.status === 'on_trip') {
      if (!ride.interrupted_at) {
        return respond({
          error:
            'This trip is still in progress and was not interrupted. A ' +
            'refund can only follow a recorded interruption (breakdown) ' +
            'and an admin decision.',
        }, 409)
      }
      // Interrupted trip: allowed, but it stays an explicit act — the ride
      // status is NOT moved off 'on_trip' here (the passenger may still be
      // aboard and tracked); only the payment is refunded.
    } else if (!refundableStatuses.includes(ride.status)) {
      return respond({
        error: `This ride (status "${ride.status}") cannot be refunded.`,
      }, 409)
    }

    if (!['success', 'refunded'].includes(payment.status)) {
      return respond({
        error: 'Only successfully paid rides can be refunded.',
      }, 409)
    }

    // A cash payment never reached Paystack. Refunding it is a manual /
    // admin reconciliation — never an automatic call to the provider.
    // (Only an explicit 'cash' method is blocked; legacy NULL rows were all
    // Paystack charges and stay refundable.)
    if (payment.status === 'success' && isCashMethod(payment.method)) {
      await auditEvent('refund_blocked_cash', {
        payment_id: payment.id,
        payment_method: payment.method ?? 'unknown',
        detail: 'cash payments are not sent to Paystack',
      })
      return respond({
        error:
          'This payment was collected as cash, so it cannot be refunded ' +
          'through Paystack. Arrange the cash refund manually and record ' +
          'it in the payment history.',
        payment_method: payment.method ?? 'unknown',
      }, 409)
    }

    if (payment.status !== 'refunded') {
      let response: Response

      try {
        response = await fetch('https://api.paystack.co/refund', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${paystackSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            transaction: payment.paystack_ref,
            currency: 'NGN',
            customer_note:
              'Refund for a cancelled Danfolio Logistics ride.',
            merchant_note:
              `Danfolio Logistics refund for ride ${rideId}`,
          }),
          signal: AbortSignal.timeout(20000),
        })
      } catch {
        // The request may have reached Paystack despite a network timeout.
        // Do not blindly retry: check the Paystack dashboard first.
        console.error(
          'Refund request outcome is uncertain; manual review is required.',
        )
        return respond({
          error:
            'We could not confirm the refund request. Check Paystack before retrying to avoid a duplicate refund.',
        }, 502)
      }

      const result = await response.json().catch(() => null)

      if (!response.ok || !result?.status || !result?.data) {
        console.error('Paystack refund request was rejected:', result?.message)
        return respond({
          error: result?.message || 'Paystack could not initiate the refund.',
        }, 502)
      }

      // Paystack accepted the refund request. Its final processing can take
      // additional time. The current project schema has no refund-pending
      // status, so a separate refund-status tracking improvement is still needed.
      const { data: updatedPayment, error: updatePaymentError } = await admin
        .from('payments')
        .update({ status: 'refunded' })
        .eq('id', payment.id)
        .eq('status', 'success')
        .select('id')
        .maybeSingle()

      if (updatePaymentError) throw updatePaymentError

      if (!updatedPayment) {
        return respond({
          error:
            'Paystack accepted the refund, but the payment record changed. Admin review is required.',
        }, 409)
      }
    }

    if (ride.status !== 'refunded' && ride.status !== 'on_trip') {
      // Same guarded set the eligibility check allowed above.
      const { data: updatedRide, error: updateRideError } = await admin
        .from('rides')
        .update({ status: 'refunded' })
        .eq('id', rideId)
        .in('status', ['paid', 'arrived', 'searching', 'accepted', 'cancelled'])
        .select('id')
        .maybeSingle()

      if (updateRideError) throw updateRideError

      if (!updatedRide) {
        return respond({
          error:
            'The refund was initiated, but the ride status changed. Admin review is required.',
        }, 409)
      }
    }
    // An interrupted on_trip ride keeps its status: the passenger may still
    // be aboard with live tracking (and possibly a replacement keke), so the
    // trip must not disappear into 'refunded' underneath them.

    await auditEvent('payment_refunded', {
      payment_id: payment.id,
      method: payment.method ?? 'unknown',
      amount: payment.amount,
      ride_status_after: ride.status === 'on_trip' ? 'on_trip (unchanged)' : 'refunded',
    })

    if (ride.keke_id && ride.status !== 'on_trip') {
      // Only returns the rider to 'online' when this refund ended their last
      // active ride — a keke holds up to 3 passengers at once.
      const { error: releaseError } = await admin.rpc('release_keke_if_idle', {
        p_keke_id: ride.keke_id,
      })

      if (releaseError) {
        console.error('Could not release rider after refund:', releaseError)

        return respond({
          status: 'refunded',
          ride_id: rideId,
          warning: 'Rider status needs admin review.',
        })
      }
    }

    return respond({
      status: 'refunded',
      ride_id: rideId,
      message:
        'Paystack accepted the refund request. Final bank processing may take additional time.',
    })
  } catch (error) {
    console.error('refund-ride failed:', error)

    return respond({
      error: 'Could not complete the refund operation. Admin review may be required.',
    }, 500)
  }
})
