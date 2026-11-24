import { isCashMethod } from './policy.js'
import { requestRefund } from './paystack.js'
import {
  isRefundClaimable,
  refundEligibility,
  refundWebhookStatus,
} from './refundPolicy.js'

// Refund orchestration, with every side effect injected through `store`
// (the database) and `fetchImpl` (Paystack). That is what makes the whole
// flow testable against an in-memory database and a local stub server —
// no live Supabase, no live Paystack.

const MAX_REASON_LENGTH = 200

export function normaliseRefundReason(reason, fallback = 'unspecified') {
  if (typeof reason !== 'string') return fallback
  const cleaned = reason.trim().replace(/\s+/g, ' ').slice(0, MAX_REASON_LENGTH)
  return cleaned || fallback
}

const ACTOR_ROLES = ['student', 'rider', 'admin', 'system']

function normaliseActor(actor) {
  const id = typeof actor?.id === 'string' ? actor.id : null
  const role = ACTOR_ROLES.includes(actor?.role) ? actor.role : 'system'
  return { id, role }
}

function releaseQuietly(store, kekeId) {
  // Releasing the rider back to 'online' is cleanup, not the refund itself:
  // a failure here must never turn a recorded refund into an error response.
  return Promise.resolve(store.releaseKeke(kekeId)).catch((error) => {
    console.error('refund: could not release keke:', error)
    return null
  })
}

function alreadyDone(rideId, payment) {
  if (payment.refund_status === 'processed') {
    return {
      status: 200,
      body: {
        status: 'refunded',
        ride_id: rideId,
        refund_status: 'processed',
        refund_reference: payment.refund_reference ?? null,
        already_refunded: true,
      },
    }
  }

  if (payment.refund_status === 'pending') {
    return {
      status: 200,
      body: {
        status: 'refund_pending',
        ride_id: rideId,
        refund_status: 'pending',
        refund_reference: payment.refund_reference ?? null,
        already_refunded: true,
        message:
          'A refund for this ride is already with Paystack and has not been ' +
          'confirmed yet. It is never sent twice.',
      },
    }
  }

  // Row refunded before refund tracking existed: no provider id, so its true
  // state cannot be re-verified from here.
  if (payment.status === 'refunded') {
    return {
      status: 200,
      body: {
        status: 'refunded',
        ride_id: rideId,
        refund_status: null,
        already_refunded: true,
        legacy: true,
      },
    }
  }

  return null
}

export async function performRefund({
  store,
  env,
  fetchImpl,
  rideId,
  reason,
  actor,
  now = new Date().toISOString(),
  timeoutMs,
}) {
  const ride = await store.getRide(rideId)
  if (!ride) return { status: 404, body: { error: 'Ride not found.' } }

  const payment = await store.getPayment(rideId)
  if (!payment) {
    return { status: 404, body: { error: 'No payment record exists for this ride.' } }
  }

  const refundReason = normaliseRefundReason(reason)
  const { id: actorId, role: actorRole } = normaliseActor(actor)

  const audit = (event, metadata, extra = {}) =>
    store.recordEvent({
      rideId,
      event,
      metadata,
      reason: refundReason,
      actorId,
      actorRole,
      ...extra,
    })

  const finished = alreadyDone(rideId, payment)
  if (finished) {
    if (ride.keke_id && ride.status !== 'on_trip') {
      await releaseQuietly(store, ride.keke_id)
    }
    return finished
  }

  const eligibility = refundEligibility({ ride, payment })
  if (!eligibility.ok) {
    return { status: eligibility.httpStatus, body: eligibility.body }
  }

  // A cash payment never reached Paystack. Refunding it is manual / admin
  // reconciliation — never an automatic provider call. (Only an explicit
  // 'cash' method is blocked; legacy NULL rows were Paystack charges.)
  if (isCashMethod(payment.method)) {
    await audit('refund_blocked_cash', {
      payment_id: payment.id,
      payment_method: payment.method,
      detail: 'cash payments are not sent to Paystack',
    })
    return {
      status: 409,
      body: {
        error:
          'This payment was collected as cash, so it cannot be refunded ' +
          'through Paystack. Arrange the cash refund manually and record ' +
          'it in the payment history.',
        payment_method: payment.method,
      },
    }
  }

  if (!isRefundClaimable(payment)) {
    const latest = await store.getPayment(rideId)
    const retry = latest && alreadyDone(rideId, latest)
    if (retry) return retry
    return {
      status: 409,
      body: {
        error: 'A refund for this payment is already in progress or needs admin review.',
        refund_status: latest?.refund_status ?? null,
      },
    }
  }

  // Claim the refund BEFORE calling Paystack. The conditional update is the
  // idempotency lock: a concurrent or repeated request cannot claim twice, so
  // Paystack can never receive two refunds for one payment.
  const claimed = await store.claimRefund(payment.id, {
    reason: refundReason,
    actorId,
    now,
  })

  if (!claimed) {
    const latest = await store.getPayment(rideId)
    const retry = latest && alreadyDone(rideId, latest)
    if (retry) return retry
    return {
      status: 409,
      body: {
        error: 'A refund for this payment is already in progress.',
        refund_status: latest?.refund_status ?? null,
      },
    }
  }

  const outcome = await requestRefund({
    env,
    fetchImpl,
    payment,
    rideId,
    reason: refundReason,
    timeoutMs,
  })

  if (outcome.state === 'rejected') {
    // Definite refusal: no refund exists at Paystack, the ride is untouched,
    // and a later retry is safe. Flag it so the admin sees the refusal.
    await store.markRefundFailed(payment.id, {
      refundStatus: 'failed',
      error: outcome.message,
      needsAttention: true,
    })
    await audit('refund_failed', {
      payment_id: payment.id,
      method: payment.method ?? 'unknown',
      amount: payment.amount,
      stage: 'provider_rejected',
      provider_status: outcome.httpStatus,
      detail: outcome.message,
    })
    return {
      status: 502,
      body: {
        error: outcome.message,
        refund_status: 'failed',
        ride_status: ride.status,
      },
    }
  }

  if (outcome.state === 'uncertain') {
    // The request MAY have created a refund. Keep it 'pending' (so it is
    // never retried automatically) and hand it to a human.
    await store.markRefundFailed(payment.id, {
      refundStatus: 'pending',
      error: outcome.detail,
      needsAttention: true,
    })
    await audit('refund_unconfirmed', {
      payment_id: payment.id,
      method: payment.method ?? 'unknown',
      amount: payment.amount,
      stage: 'network_uncertain',
      detail: outcome.detail,
      next: 'manual_review',
    })
    return {
      status: 502,
      body: {
        error:
          'We could not confirm the refund request. Check Paystack before ' +
          'retrying to avoid a duplicate refund.',
        refund_status: 'pending',
        needs_attention: true,
      },
    }
  }

  // Paystack accepted (and may already have processed) the refund.
  const processed = outcome.status === 'processed'

  await store.markRefundAccepted(payment.id, {
    reference: outcome.reference,
    refundStatus: processed ? 'processed' : 'pending',
    processed,
    now,
  })

  let rideStatusAfter = ride.status
  if (ride.status !== 'on_trip') {
    const moved = await store.setRideStatus(rideId, 'refunded', [
      'paid',
      'arrived',
      'searching',
      'accepted',
      'cancelled',
    ])
    rideStatusAfter = moved ? 'refunded' : ride.status
  }
  // An interrupted on_trip ride keeps its status: the passenger may still be
  // aboard with live tracking, so it must not vanish into 'refunded'.

  await audit('payment_refunded', {
    payment_id: payment.id,
    method: payment.method ?? 'unknown',
    amount: payment.amount,
    refund_reference: outcome.reference,
    refund_status: processed ? 'processed' : 'pending',
    provider_status: outcome.providerStatus,
    ride_status_after: rideStatusAfter === 'on_trip' ? 'on_trip (unchanged)' : rideStatusAfter,
  })

  if (ride.keke_id && ride.status !== 'on_trip') {
    await releaseQuietly(store, ride.keke_id)
  }

  return {
    status: 200,
    body: {
      status: processed ? 'refunded' : 'refund_pending',
      ride_id: rideId,
      refund_status: processed ? 'processed' : 'pending',
      refund_reference: outcome.reference,
      message: processed
        ? 'Paystack confirmed the refund.'
        : 'Paystack accepted the refund request. Final bank processing may take additional time.',
    },
  }
}

// Handles refund.processed / refund.failed. The caller MUST have verified the
// Paystack signature first (see verifyPaystackSignature).
export async function applyRefundWebhook({
  store,
  event,
  data,
  now = new Date().toISOString(),
}) {
  const status = refundWebhookStatus(event)
  if (!status) return { handled: false }

  const reference = typeof data?.transaction?.reference === 'string'
    ? data.transaction.reference
    : typeof data?.transaction_reference === 'string'
      ? data.transaction_reference
      : null

  const refundReference = data?.id !== undefined && data?.id !== null
    ? String(data.id)
    : null

  if (!reference && !refundReference) {
    return { handled: true, ignored: 'no_reference' }
  }

  const payment = await store.findPayment({ reference, refundReference })
  if (!payment) return { handled: true, ignored: 'unknown_reference' }

  const ride = payment.ride_id ? await store.getRide(payment.ride_id) : null

  if (status === 'processed') {
    if (payment.refund_status === 'processed') {
      return { handled: true, refund_status: 'processed', already: true }
    }

    await store.updatePayment(payment.id, {
      status: 'refunded',
      refund_status: 'processed',
      refund_reference: refundReference ?? payment.refund_reference ?? null,
      refunded_at: payment.refunded_at ?? now,
      refund_last_error: null,
      refund_needs_attention: false,
    })

    let rideStatus = ride?.status ?? null
    if (ride && ride.status !== 'on_trip') {
      const moved = await store.setRideStatus(ride.id, 'refunded', [
        'paid',
        'arrived',
        'searching',
        'accepted',
        'cancelled',
        'refunded',
      ])
      if (moved) rideStatus = 'refunded'
    }

    await store.recordEvent({
      rideId: payment.ride_id,
      event: 'refund_processed',
      actorRole: 'system',
      toStatus: rideStatus,
      metadata: {
        payment_id: payment.id,
        refund_reference: refundReference,
        provider_status: data?.status ?? null,
        confirmed_by: 'paystack_webhook',
      },
    })

    if (ride?.keke_id && ride.status !== 'on_trip') {
      await releaseQuietly(store, ride.keke_id)
    }

    return { handled: true, refund_status: 'processed', ride_status: rideStatus }
  }

  // refund.failed — the money did NOT go back. Nothing may look refunded.
  const detail = typeof data?.reason === 'string' && data.reason
    ? data.reason
    : typeof data?.message === 'string' && data.message
      ? data.message
      : 'Paystack reported the refund failed.'

  const alreadyFailed = payment.refund_status === 'failed' &&
    payment.refund_needs_attention === true

  const patch = {
    refund_status: 'failed',
    refund_reference: refundReference ?? payment.refund_reference ?? null,
    refund_last_error: detail,
    refund_needs_attention: true,
  }

  // A payment marked refunded (e.g. a refund that was later reversed) must
  // not keep claiming the money was returned.
  if (payment.status === 'refunded') patch.status = 'success'

  if (!alreadyFailed) {
    await store.updatePayment(payment.id, patch)
  }

  let rideStatus = ride?.status ?? null
  if (ride?.status === 'refunded') {
    const reverted = await store.setRideStatus(ride.id, 'cancelled', ['refunded'])
    if (reverted) rideStatus = 'cancelled'
  }

  if (!alreadyFailed) {
    await store.recordEvent({
      rideId: payment.ride_id,
      event: 'refund_failed',
      reason: detail,
      actorRole: 'system',
      fromStatus: ride?.status ?? null,
      toStatus: rideStatus,
      metadata: {
        payment_id: payment.id,
        refund_reference: refundReference,
        provider_status: data?.status ?? null,
        needs_attention: true,
        ride_status_reverted: rideStatus !== (ride?.status ?? null),
      },
    })
  }

  return {
    handled: true,
    refund_status: 'failed',
    needs_attention: true,
    ride_status: rideStatus,
  }
}
