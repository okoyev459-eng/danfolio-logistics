import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
      .select('id, keke_id, status')
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) throw rideError
    if (!ride) return respond({ error: 'Ride not found.' }, 404)

    const { data: payment, error: paymentError } = await admin
      .from('payments')
      .select('id, paystack_ref, amount, status')
      .eq('ride_id', rideId)
      .maybeSingle()

    if (paymentError) throw paymentError
    if (!payment) {
      return respond({ error: 'No payment record exists for this ride.' }, 404)
    }

    if (ride.status === 'refunded' && payment.status === 'refunded') {
      // Retry-safe cleanup if an earlier attempt did not release the rider.
      if (ride.keke_id) {
        const { error } = await admin
          .from('kekes')
          .update({
            status: 'online',
            last_seen: new Date().toISOString(),
          })
          .eq('id', ride.keke_id)
          .eq('status', 'on_trip')

        if (error) throw error
      }

      return respond({
        status: 'refunded',
        ride_id: rideId,
        already_refunded: true,
      })
    }

    if (!['paid', 'arrived', 'refunded'].includes(ride.status)) {
      return respond({
        error: 'Only paid or arrived rides can be refunded.',
      }, 409)
    }

    if (!['success', 'refunded'].includes(payment.status)) {
      return respond({
        error: 'Only successfully paid rides can be refunded.',
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

    if (ride.status !== 'refunded') {
      const { data: updatedRide, error: updateRideError } = await admin
        .from('rides')
        .update({ status: 'refunded' })
        .eq('id', rideId)
        .in('status', ['paid', 'arrived'])
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

    if (ride.keke_id) {
      const { error: releaseError } = await admin
        .from('kekes')
        .update({
          status: 'online',
          last_seen: new Date().toISOString(),
        })
        .eq('id', ride.keke_id)
        .eq('status', 'on_trip')

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
