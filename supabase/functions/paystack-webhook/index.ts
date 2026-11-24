import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { estimateProviderFee, rideTotal, SERVICE_FEE_NGN } from '../_shared/policy.js'
import { verifyPaystackSignature } from '../_shared/paystack.js'
import { applyRefundWebhook } from '../_shared/refundFlow.js'
import { createRefundStore } from '../_shared/refundStore.js'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-paystack-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type PaystackPayload = {
  event?: string
  data?: {
    id?: number | string
    reference?: string
    transaction_reference?: string
    transaction?: { reference?: string }
    amount?: number
    currency?: string
    status?: string
    channel?: string
    reason?: string
    message?: string
  }
}

// Which digital method Paystack reports. Anything we do not recognise stays
// NULL rather than being guessed — an unknown channel is still digital (it
// arrived through this webhook, so it is refundable through Paystack), and
// refunds treat NULL as digital for exactly that reason.
function normaliseChannel(channel: string | undefined): 'card' | 'transfer' | null {
  if (!channel) return null
  const c = channel.toLowerCase()
  if (c === 'card') return 'card'
  // bank_transfer, bank, ussd, qr, mobile_money … all settle digitally.
  return 'transfer'
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
    const secret = Deno.env.get('PAYSTACK_SECRET_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!secret || !supabaseUrl || !serviceRoleKey) {
      console.error('Webhook configuration is incomplete.')
      return respond({ error: 'Payment service configuration is incomplete.' }, 500)
    }

    // Verify the exact raw request body before parsing it.
    const rawBody = await req.text()
    const suppliedSignature = req.headers.get('x-paystack-signature')

    if (!suppliedSignature) {
      return respond({ error: 'Missing payment signature.' }, 401)
    }

    const signatureValid = await verifyPaystackSignature({
      rawBody,
      signature: suppliedSignature,
      secret,
    })

    if (!signatureValid) {
      return respond({ error: 'Invalid payment signature.' }, 401)
    }

    let payload: PaystackPayload

    try {
      payload = JSON.parse(rawBody)
    } catch {
      return respond({ error: 'Invalid webhook payload.' }, 400)
    }

    // Refund outcomes change whether the student's money actually came back.
    // The signature above is the ONLY thing that makes this trustworthy.
    if (payload.event === 'refund.processed' || payload.event === 'refund.failed') {
      const refundAdmin = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })

      const outcome = await applyRefundWebhook({
        store: createRefundStore(refundAdmin),
        event: payload.event,
        data: payload.data,
      })

      return respond({ received: true, ...outcome })
    }

    // Acknowledge other event types; this function handles successful charges.
    if (payload.event !== 'charge.success') {
      return respond({ received: true, ignored: true })
    }

    const event = payload.data
    const reference = event?.reference
    const amountKobo = event?.amount

    if (
      typeof reference !== 'string' ||
      !reference ||
      !Number.isSafeInteger(amountKobo) ||
      Number(amountKobo) <= 0 ||
      event?.currency !== 'NGN' ||
      (event.status && event.status !== 'success')
    ) {
      return respond({ error: 'Invalid successful-payment details.' }, 400)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: payment, error: paymentError } = await admin
      .from('payments')
      .select('id, ride_id, amount, status, paystack_ref, service_fee, refund_status')
      .eq('paystack_ref', reference)
      .maybeSingle()

    if (paymentError) throw paymentError

    if (!payment) {
      // Do not keep retrying an event for a reference Danfolio never created.
      console.error('Successful Paystack charge has an unknown reference.')
      return respond({ received: true, ignored: 'unknown_reference' })
    }

    // The database stores whole naira; Paystack reports kobo.
    if (Number(payment.amount) * 100 !== Number(amountKobo)) {
      console.error('Paystack amount does not match the stored payment.')
      return respond({ error: 'Payment amount mismatch.' }, 400)
    }

    if (payment.status === 'refunded' || payment.refund_status === 'processed') {
      return respond({ received: true, ignored: 'already_refunded' })
    }

    // The refund is already with Paystack (or needs review): never ask for a
    // second one just because Paystack re-delivered charge.success.
    if (payment.refund_status === 'pending') {
      return respond({ received: true, ignored: 'refund_in_progress' })
    }

    const { data: ride, error: rideError } = await admin
      .from('rides')
      .select('id, status, student_id')
      .eq('id', payment.ride_id)
      .maybeSingle()

    if (rideError) throw rideError
    if (!ride) {
      console.error('Payment references a ride that no longer exists.')
      return respond({ error: 'Associated ride not found.' }, 500)
    }

    // Record the verified payment. If a later step fails, Paystack can retry
    // and this handler will safely continue from the existing state.
    if (payment.status !== 'success') {
      const channelMethod = normaliseChannel(
        (payload.data as { channel?: string } | undefined)?.channel,
      )

      const updatePayload: Record<string, unknown> = { status: 'success' }
      if (channelMethod) updatePayload.method = channelMethod
      // Legacy rows (started before service_fee existed) get it stamped here.
      if (payment.service_fee === null || payment.service_fee === undefined) {
        updatePayload.service_fee = SERVICE_FEE_NGN
      }

      const { error: markPaymentError } = await admin
        .from('payments')
        .update(updatePayload)
        .eq('id', payment.id)
        .in('status', ['pending', 'failed'])

      if (markPaymentError) throw markPaymentError

      // Auditable history: what the student paid, Danfolio's fixed fee, and
      // the ESTIMATED provider fee (never used to move money — it documents
      // the margin after Paystack's cut).
      const chargedNaira = Number(payment.amount)
      const providerFee = estimateProviderFee(chargedNaira)
      const farePart = chargedNaira - SERVICE_FEE_NGN

      const { error: eventError } = await admin.from('ride_events').insert({
        ride_id: payment.ride_id,
        actor_role: 'student',
        event: 'payment_verified',
        from_status: payment.status,
        to_status: 'success',
        metadata: {
          payment_id: payment.id,
          paystack_ref: reference,
          channel: (payload.data as { channel?: string } | undefined)?.channel ?? null,
          method: channelMethod,
          charged_naira: chargedNaira,
          fare_naira: farePart,
          service_fee_naira: SERVICE_FEE_NGN,
          provider_fee_estimate: providerFee,
          expected_total_check: rideTotal(farePart, SERVICE_FEE_NGN) === chargedNaira,
        },
      })

      if (eventError) console.error('webhook: could not record payment_verified:', eventError)
    }

    if (ride.status === 'cancelled' || ride.status === 'refunded') {
      // A late charge after cancellation needs separate refund handling.
      console.error('Payment succeeded after ride cancellation; refund review required.')
      return respond({
        received: true,
        refund_required: true,
        ride_id: ride.id,
      })
    }

    if (ride.status === 'accepted') {
      const { data: updatedRide, error: updateRideError } = await admin
        .from('rides')
        .update({ status: 'paid' })
        .eq('id', ride.id)
        .eq('status', 'accepted')
        .select('id')
        .maybeSingle()

      if (updateRideError) throw updateRideError

      if (!updatedRide) {
        // A concurrent webhook may have advanced the ride already.
        const { data: latestRide, error: latestRideError } = await admin
          .from('rides')
          .select('status')
          .eq('id', ride.id)
          .maybeSingle()

        if (latestRideError) throw latestRideError

        if (!latestRide || !['paid', 'arrived', 'on_trip', 'completed'].includes(latestRide.status)) {
          throw new Error('Ride status changed before payment confirmation completed.')
        }
      }
    } else if (!['paid', 'arrived', 'on_trip', 'completed'].includes(ride.status)) {
      return respond({ error: 'Ride is not in a payable state.' }, 409)
    }

    // Return an existing ticket on webhook retries; never create a second ticket.
    const { data: existingTicket, error: ticketReadError } = await admin
      .from('tickets')
      .select('ticket_no, status')
      .eq('ride_id', ride.id)
      .maybeSingle()

    if (ticketReadError) throw ticketReadError

    if (existingTicket) {
      return respond({
        received: true,
        payment_status: 'success',
        ride_status: 'paid',
        ticket_no: existingTicket.ticket_no,
        ticket_status: existingTicket.status,
      })
    }

    const datePart = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    let createdTicket: { ticket_no: string; status: string } | null = null

    // ticket_no is unique. Retry if another ride happened to receive the same
    // four-digit suffix; ride_id uniqueness protects against duplicate tickets.
    for (let attempt = 0; attempt < 10; attempt++) {
      const random = new Uint32Array(1)
      crypto.getRandomValues(random)
      const suffix = String((random[0] % 9000) + 1000)
      const ticketNo = `KK-${datePart}-${suffix}`

      const { data: inserted, error: insertError } = await admin
        .from('tickets')
        .insert({
          ride_id: ride.id,
          ticket_no: ticketNo,
          status: 'unused',
        })
        .select('ticket_no, status')
        .maybeSingle()

      if (!insertError && inserted) {
        createdTicket = inserted
        break
      }

      if (insertError?.code === '23505') {
        // If another delivery created this ride's ticket concurrently, reuse it.
        const { data: concurrentTicket, error: concurrentReadError } = await admin
          .from('tickets')
          .select('ticket_no, status')
          .eq('ride_id', ride.id)
          .maybeSingle()

        if (concurrentReadError) throw concurrentReadError

        if (concurrentTicket) {
          createdTicket = concurrentTicket
          break
        }

        // Otherwise it was a ticket-number collision; generate another suffix.
        continue
      }

      if (insertError) throw insertError
    }

    if (!createdTicket) {
      throw new Error('Could not create a unique ticket after multiple attempts.')
    }

    return respond({
      received: true,
      payment_status: 'success',
      ride_status: 'paid',
      ticket_no: createdTicket.ticket_no,
      ticket_status: createdTicket.status,
    })
  } catch (error) {
    console.error('paystack-webhook failed:', error)
    return respond({ error: 'Payment confirmation could not be completed.' }, 500)
  }
})
