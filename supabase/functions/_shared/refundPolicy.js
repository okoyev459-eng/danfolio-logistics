import { isCashMethod } from './policy.js'

// Pure refund decisions. No I/O, no provider calls: the same functions drive
// the live Edge Functions and the hermetic tests, so a test cannot pass while
// production takes a different branch.

export const REFUND_STATUSES = ['pending', 'processed', 'failed']

// Ride statuses whose refund is allowed when this payment actually moved
// money. 'completed' is deliberately absent (a finished trip is settled) and
// 'on_trip' only through a recorded interruption.
export const REFUNDABLE_RIDE_STATUSES = [
  'paid',
  'arrived',
  'searching',
  'accepted',
  'cancelled',
  'refunded',
]

// A payment may be sent to Paystack only when no refund has been claimed yet,
// or when a previous attempt was DEFINITELY rejected (failed, no provider
// refund id). A pending or uncertain attempt is never retried automatically —
// it may already exist at Paystack.
export function isRefundClaimable(payment) {
  if (!payment) return false
  if (payment.status !== 'success') return false
  if (payment.refund_status === null || payment.refund_status === undefined) {
    return true
  }
  return payment.refund_status === 'failed' && !payment.refund_reference
}

// Whether this ride+payment pair may be sent to the refund provider.
export function refundEligibility({ ride, payment }) {
  if (ride.status === 'on_trip') {
    if (!ride.interrupted_at) {
      return {
        ok: false,
        httpStatus: 409,
        body: {
          error:
            'This trip is still in progress and was not interrupted. A ' +
            'refund can only follow a recorded interruption (breakdown) ' +
            'and an admin decision.',
        },
      }
    }
  } else if (!REFUNDABLE_RIDE_STATUSES.includes(ride.status)) {
    return {
      ok: false,
      httpStatus: 409,
      body: {
        error: `This ride (status "${ride.status}") cannot be refunded.`,
      },
    }
  }

  if (!['success', 'refunded'].includes(payment.status)) {
    return {
      ok: false,
      httpStatus: 409,
      body: { error: 'Only successfully paid rides can be refunded.' },
    }
  }

  return { ok: true }
}

// The student cancellation path (cancel-ride) in one place.
//
//   cancel            close the booking, no money moved
//   refund            send the payment through refund-ride/Paystack
//   cancel_cash_manual close it and tell the student cash is settled by hand
//   already_*         idempotent retry of a finished cancellation
//   blocked_*         refuse, with the reason the caller reports
export function decideStudentCancellation({ ride, payment }) {
  const status = ride.status

  if (status === 'cancelled') return { action: 'already_cancelled' }
  if (status === 'refunded') return { action: 'already_refunded' }

  if (ride.interrupted_at && status === 'on_trip') {
    return { action: 'blocked_interrupted' }
  }
  if (status === 'completed') return { action: 'blocked_completed' }

  const paid = payment?.status === 'success'
  const cash = paid && isCashMethod(payment?.method)

  // Post-boarding is never a cancellation, cash or not.
  if (status === 'on_trip') return { action: 'blocked_status' }

  // Payment is checked BEFORE the status branch: a paid booking that was
  // re-dispatched back to 'searching' (or sits at 'accepted') must still be
  // REFUNDED, never cancelled for free.
  if (paid && !cash) return { action: 'refund' }
  if (cash) return { action: 'cancel_cash_manual' }
  if (status === 'paid') return { action: 'refund' }

  if (['searching', 'accepted', 'arrived'].includes(status)) {
    return { action: 'cancel' }
  }

  return { action: 'blocked_status' }
}

// The rider's pre-boarding cancellation (rider-cancel-ride 'redispatch').
// The booking is preserved and re-offered, so the payment stays untouched;
// only a dispatch that found NO keke at all (auto-cancelled) refunds money.
export function decideRedispatchOutcome({ dispatchState, payment }) {
  if (dispatchState === 'offered') return { action: 'payment_preserved' }
  if (payment?.status !== 'success') return { action: 'no_refund' }
  if (isCashMethod(payment.method)) return { action: 'manual_cash' }
  return { action: 'refund' }
}

export function refundWebhookStatus(event) {
  if (event === 'refund.processed') return 'processed'
  if (event === 'refund.failed') return 'failed'
  return null
}
