import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { performRefund } from '../_shared/refundFlow.js'
import { createRefundStore } from '../_shared/refundStore.js'

// refund-ride — server-to-server refund of a VERIFIED payment.
//
// Guard rails (unchanged):
//   * only a payment with status 'success' (or a legacy 'refunded' row) can
//     ever be refunded, and only through Paystack when the method is digital
//     (card/transfer). A CASH payment never reached Paystack — it returns 409
//     so no system or student path can silently "refund" money never charged;
//   * ride statuses: paid / arrived always; searching / accepted / cancelled
//     / refunded when a successful payment exists; on_trip ONLY when the trip
//     is recorded as interrupted (admin-decided); completed never;
//   * retry-safe: a claimed or finished refund is reported WITHOUT a second
//     Paystack call. The conditional claim in refundStore is the lock.
//
// What changed (refund safety):
//   * Paystack's refund id + status are stored (refund_reference,
//     refund_status). payments.status = 'refunded' now means Paystack
//     CONFIRMED the refund, not merely accepted the request; an accepted
//     request leaves the payment 'success' with refund_status 'pending' until
//     the refund.processed webhook arrives;
//   * a provider rejection or network timeout is recorded with
//     refund_needs_attention = true and never marks the ride refunded;
//   * the reason and the calling actor are recorded in ride_events;
//   * PAYSTACK_API_BASE can point at a local stub for the hermetic tests.

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

    let body: {
      ride_id?: string
      reason?: string
      actor_id?: string | null
      actor_role?: string
    }

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

    const result = await performRefund({
      store: createRefundStore(admin),
      env: {
        PAYSTACK_SECRET_KEY: paystackSecret,
        PAYSTACK_API_BASE: Deno.env.get('PAYSTACK_API_BASE'),
      },
      rideId,
      reason: body?.reason,
      actor: {
        id: typeof body?.actor_id === 'string' ? body.actor_id : null,
        role: body?.actor_role,
      },
    })

    return respond(result.body, result.status)
  } catch (error) {
    console.error('refund-ride failed:', error)

    return respond({
      error: 'Could not complete the refund operation. Admin review may be required.',
    }, 500)
  }
})
