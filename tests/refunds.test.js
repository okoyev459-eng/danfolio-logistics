import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  PAYSTACK_DEFAULT_BASE,
  paystackBaseUrl,
  requestRefund,
  signWebhookBody,
  verifyPaystackSignature,
} from '../supabase/functions/_shared/paystack.js'
import {
  decideRedispatchOutcome,
  decideStudentCancellation,
  isRefundClaimable,
} from '../supabase/functions/_shared/refundPolicy.js'
import {
  applyRefundWebhook,
  performRefund,
} from '../supabase/functions/_shared/refundFlow.js'

// Hermetic refund tests.
//
//   * Paystack is a local node:http stub on 127.0.0.1 — PAYSTACK_API_BASE is
//     pointed at it, so not a single request can leave this machine.
//   * Supabase is an in-memory store implementing the SAME adapter contract
//     refundStore.js implements against Postgres, including the conditional
//     refund claim that provides idempotency.
//   * The decision functions are the ones cancel-ride / rider-cancel-ride /
//     refund-ride import, so a test cannot pass on a parallel implementation.

const RIDE_ID = '11111111-1111-4111-8111-111111111111'
const PAYMENT_ID = '22222222-2222-4222-8222-222222222222'
const KEKE_ID = '33333333-3333-4333-8333-333333333333'
const STUDENT_ID = '44444444-4444-4444-8444-444444444444'
const SECRET = 'sk_test_hermetic_refund_secret'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relPath) => readFileSync(path.join(ROOT, relPath), 'utf8')

const stubs = []

afterEach(async () => {
  while (stubs.length) {
    await stubs.pop().close()
  }
})

function respondJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Every request the code under test sends to "Paystack" lands here and is
// recorded, so the tests can prove how many refunds were requested and with
// what payload.
async function startPaystackStub(handler) {
  const requests = []
  const sockets = new Set()

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }

      const entry = {
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        body,
      }
      requests.push(entry)

      Promise.resolve(handler(entry, res)).catch(() => {
        try {
          res.destroy()
        } catch {
          // already gone
        }
      })
    })
  })

  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  const stub = {
    requests,
    url: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }

  stubs.push(stub)
  return stub
}

function makeWorld({ ride = {}, payment } = {}) {
  const world = {
    ride: {
      id: RIDE_ID,
      keke_id: KEKE_ID,
      status: 'paid',
      interrupted_at: null,
      ...ride,
    },
    payment: payment !== null
      ? {
          id: PAYMENT_ID,
          ride_id: RIDE_ID,
          paystack_ref: 'DF-paystack-ref-1',
          amount: 520,
          status: 'success',
          method: 'card',
          refund_status: null,
          refund_reference: null,
          refunded_at: null,
          refund_needs_attention: false,
          ...payment,
        }
      : null,
    events: [],
    releases: [],
  }

  const store = {
    async getRide(id) {
      return world.ride?.id === id ? { ...world.ride } : null
    },

    async getPayment(rideId) {
      return world.payment && world.payment.ride_id === rideId
        ? { ...world.payment }
        : null
    },

    async findPayment({ reference, refundReference }) {
      const payment = world.payment
      if (!payment) return null
      if (reference) {
        return payment.paystack_ref === reference ? { ...payment } : null
      }
      return payment.refund_reference && payment.refund_reference === refundReference
        ? { ...payment }
        : null
    },

    // Mirrors refundStore.claimRefund's conditional UPDATE.
    async claimRefund(paymentId, { reason, actorId, now }) {
      const payment = world.payment
      if (!payment || payment.id !== paymentId || payment.status !== 'success') {
        return false
      }
      const claimable = payment.refund_status == null ||
        (payment.refund_status === 'failed' && !payment.refund_reference)
      if (!claimable) return false

      Object.assign(payment, {
        refund_status: 'pending',
        refund_requested_at: now,
        refund_reason: reason,
        refunded_by: actorId,
        refund_last_error: null,
        refund_needs_attention: false,
      })
      return true
    },

    async markRefundAccepted(paymentId, { reference, refundStatus, processed, now }) {
      Object.assign(world.payment, {
        refund_status: refundStatus,
        refund_reference: reference,
        refund_last_error: null,
        refund_needs_attention: false,
        ...(processed ? { status: 'refunded', refunded_at: now } : {}),
      })
    },

    async markRefundFailed(paymentId, { refundStatus, error, needsAttention }) {
      Object.assign(world.payment, {
        refund_status: refundStatus,
        refund_last_error: error,
        refund_needs_attention: needsAttention,
      })
    },

    async updatePayment(paymentId, patch) {
      Object.assign(world.payment, patch)
    },

    async setRideStatus(rideId, status, fromStatuses) {
      if (world.ride.id !== rideId) return false
      if (!fromStatuses.includes(world.ride.status)) return false
      world.ride.status = status
      return true
    },

    async releaseKeke(kekeId) {
      world.releases.push(kekeId)
      return true
    },

    async recordEvent(event) {
      world.events.push(event)
      return true
    },
  }

  return { world, store }
}

// Guards against these tests passing while the deployed functions take a
// different branch: the wrappers must import the shared modules tested here.
describe('drift-check: Edge Functions use the tested shared refund code', () => {
  const refundRide = read('supabase/functions/refund-ride/index.ts')
  const webhook = read('supabase/functions/paystack-webhook/index.ts')
  const cancelRide = read('supabase/functions/cancel-ride/index.ts')
  const riderCancel = read('supabase/functions/rider-cancel-ride/index.ts')

  it('refund-ride delegates to the shared refund flow, not an inline API URL', () => {
    expect(refundRide).toContain("from '../_shared/refundFlow.js'")
    expect(refundRide).toContain("from '../_shared/refundStore.js'")
    expect(refundRide).toContain('performRefund(')
    expect(refundRide).not.toContain('https://api.paystack.co')
  })

  it('the webhook verifies the shared signature and applies refund outcomes', () => {
    expect(webhook).toContain("from '../_shared/paystack.js'")
    expect(webhook).toContain('verifyPaystackSignature(')
    expect(webhook).toContain("from '../_shared/refundFlow.js'")
    expect(webhook).toContain('applyRefundWebhook(')
    expect(webhook).toContain("'refund.processed'")
    expect(webhook).toContain("'refund.failed'")
  })

  it('the cancel paths import the cancellation decisions these tests exercise', () => {
    expect(cancelRide).toContain('decideStudentCancellation(')
    expect(riderCancel).toContain('decideRedispatchOutcome(')
  })
})

describe('PAYSTACK_API_BASE override', () => {
  it('defaults to the real Paystack API when unset', () => {
    expect(paystackBaseUrl({})).toBe(PAYSTACK_DEFAULT_BASE)
    expect(paystackBaseUrl({ PAYSTACK_API_BASE: '   ' })).toBe(PAYSTACK_DEFAULT_BASE)
  })

  it('accepts a local stub URL and strips trailing slashes', () => {
    expect(paystackBaseUrl({ PAYSTACK_API_BASE: 'http://127.0.0.1:4011/' }))
      .toBe('http://127.0.0.1:4011')
  })

  it('refuses a non-URL value instead of silently calling Paystack', () => {
    expect(() => paystackBaseUrl({ PAYSTACK_API_BASE: 'not-a-url' }))
      .toThrow(/PAYSTACK_API_BASE/)
    expect(() => paystackBaseUrl({ PAYSTACK_API_BASE: 'ftp://example.com' }))
      .toThrow(/PAYSTACK_API_BASE/)
  })
})

describe('student cancellation decision (cancel-ride)', () => {
  it('cancels a booking with no payment WITHOUT any refund', () => {
    for (const status of ['searching', 'accepted', 'arrived']) {
      const decision = decideStudentCancellation({
        ride: { status },
        payment: null,
      })
      expect(decision).toEqual({ action: 'cancel' })
    }
  })

  it('never refunds a payment that was never successful', () => {
    const decision = decideStudentCancellation({
      ride: { status: 'accepted' },
      payment: { status: 'pending', method: 'card' },
    })
    expect(decision).toEqual({ action: 'cancel' })
  })

  it('refunds a settled digital payment, even after a re-dispatch', () => {
    for (const status of ['paid', 'arrived', 'accepted', 'searching']) {
      const decision = decideStudentCancellation({
        ride: { status },
        payment: { status: 'success', method: 'card', refund_status: null },
      })
      expect(decision).toEqual({ action: 'refund' })
    }
  })

  it('treats an unknown null method as digital, cash as manual-only', () => {
    expect(decideStudentCancellation({
      ride: { status: 'paid' },
      payment: { status: 'success', method: null },
    })).toEqual({ action: 'refund' })

    expect(decideStudentCancellation({
      ride: { status: 'paid' },
      payment: { status: 'success', method: 'cash' },
    })).toEqual({ action: 'cancel_cash_manual' })
  })

  it('refuses completed, interrupted and in-progress trips', () => {
    expect(decideStudentCancellation({ ride: { status: 'completed' }, payment: null }))
      .toEqual({ action: 'blocked_completed' })

    expect(decideStudentCancellation({
      ride: { status: 'on_trip', interrupted_at: '2026-11-24T10:00:00Z' },
      payment: { status: 'success', method: 'card' },
    })).toEqual({ action: 'blocked_interrupted' })

    expect(decideStudentCancellation({
      ride: { status: 'on_trip', interrupted_at: null },
      payment: { status: 'success', method: 'card' },
    })).toEqual({ action: 'blocked_status' })
  })

  it('is idempotent for an already cancelled or refunded ride', () => {
    expect(decideStudentCancellation({ ride: { status: 'cancelled' }, payment: null }))
      .toEqual({ action: 'already_cancelled' })
    expect(decideStudentCancellation({ ride: { status: 'refunded' }, payment: null }))
      .toEqual({ action: 'already_refunded' })
  })
})

describe('keke cancellation decision (rider-cancel-ride redispatch)', () => {
  it('preserves a paid booking when the ride was re-offered', () => {
    expect(decideRedispatchOutcome({
      dispatchState: 'offered',
      payment: { status: 'success', method: 'card' },
    })).toEqual({ action: 'payment_preserved' })
  })

  it('refunds only when no keke was available and the payment settled digitally', () => {
    expect(decideRedispatchOutcome({
      dispatchState: 'no_ride_available',
      payment: { status: 'success', method: 'transfer' },
    })).toEqual({ action: 'refund' })
  })

  it('never sends an unpaid or cash booking to Paystack', () => {
    expect(decideRedispatchOutcome({
      dispatchState: 'no_ride_available',
      payment: null,
    })).toEqual({ action: 'no_refund' })

    expect(decideRedispatchOutcome({
      dispatchState: 'no_ride_available',
      payment: { status: 'success', method: 'cash' },
    })).toEqual({ action: 'manual_cash' })
  })
})

describe('refund-ride: provider call, tracking and idempotency', () => {
  it('refunds a paid ride, stores Paystack\'s refund id and keeps status honest', async () => {
    const stub = await startPaystackStub((request, res) => {
      respondJson(res, 200, {
        status: true,
        message: 'Refund has been queued for processing',
        data: { id: 987654, status: 'pending', transaction: { reference: 'DF-paystack-ref-1' } },
      })
    })

    const { world, store } = makeWorld()
    const result = await performRefund({
      store,
      env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: stub.url },
      rideId: RIDE_ID,
      reason: 'student_cancelled',
      actor: { id: STUDENT_ID, role: 'student' },
      now: '2026-11-24T12:00:00.000Z',
    })

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({
      status: 'refund_pending',
      refund_status: 'pending',
      refund_reference: '987654',
    })

    // Paystack was asked exactly once, for the full transaction (no partial
    // amount) with the service-role secret.
    expect(stub.requests).toHaveLength(1)
    expect(stub.requests[0].method).toBe('POST')
    expect(stub.requests[0].url).toBe('/refund')
    expect(stub.requests[0].authorization).toBe(`Bearer ${SECRET}`)
    expect(stub.requests[0].body.transaction).toBe('DF-paystack-ref-1')
    expect(stub.requests[0].body.currency).toBe('NGN')
    expect(stub.requests[0].body).not.toHaveProperty('amount')

    // Acceptance is NOT a completed refund: the payment stays 'success'
    // until Paystack confirms, so nothing pretends the money came back.
    expect(world.payment.refund_status).toBe('pending')
    expect(world.payment.refund_reference).toBe('987654')
    expect(world.payment.status).toBe('success')
    expect(world.payment.refunded_at).toBeNull()
    expect(world.ride.status).toBe('refunded')

    const event = world.events.find((e) => e.event === 'payment_refunded')
    expect(event).toBeTruthy()
    expect(event.reason).toBe('student_cancelled')
    expect(event.actorId).toBe(STUDENT_ID)
    expect(event.actorRole).toBe('student')
    expect(event.metadata.refund_reference).toBe('987654')
    expect(event.metadata.refund_status).toBe('pending')
    expect(world.releases).toContain(KEKE_ID)
  })

  it('marks a payment refunded immediately when Paystack reports processed', async () => {
    const stub = await startPaystackStub((request, res) => {
      respondJson(res, 200, {
        status: true,
        data: { id: 4242, status: 'processed' },
      })
    })

    const { world, store } = makeWorld()
    const result = await performRefund({
      store,
      env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: stub.url },
      rideId: RIDE_ID,
      now: '2026-11-24T12:00:00.000Z',
    })

    expect(result.body.refund_status).toBe('processed')
    expect(world.payment.status).toBe('refunded')
    expect(world.payment.refunded_at).toBe('2026-11-24T12:00:00.000Z')
  })

  it('does not create a second refund on a duplicate request', async () => {
    const stub = await startPaystackStub((request, res) => {
      respondJson(res, 200, { status: true, data: { id: 55, status: 'pending' } })
    })

    const { world, store } = makeWorld()
    const args = {
      store,
      env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: stub.url },
      rideId: RIDE_ID,
      reason: 'student_cancelled',
      actor: { id: STUDENT_ID, role: 'student' },
    }

    const first = await performRefund(args)
    const second = await performRefund(args)

    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.body.already_refunded).toBe(true)
    expect(stub.requests).toHaveLength(1)
    expect(world.payment.refund_reference).toBe('55')
    expect(world.events.filter((e) => e.event === 'payment_refunded')).toHaveLength(1)
  })

  it('blocks a second refund while one is pending (never retried blindly)', async () => {
    const stub = await startPaystackStub((request, res) => {
      respondJson(res, 200, { status: true, data: { id: 77, status: 'processing' } })
    })

    const { world, store } = makeWorld({
      payment: { refund_status: 'pending', refund_reference: null },
    })

    const result = await performRefund({
      store,
      env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: stub.url },
      rideId: RIDE_ID,
    })

    expect(result.status).toBe(200)
    expect(result.body.refund_status).toBe('pending')
    expect(result.body.already_refunded).toBe(true)
    expect(stub.requests).toHaveLength(0)
    expect(world.payment.refund_status).toBe('pending')
  })

  it('records a provider failure, keeps the ride unrefunded and allows a safe retry', async () => {
    let call = 0
    const stub = await startPaystackStub((request, res) => {
      call += 1
      if (call === 1) {
        respondJson(res, 400, { status: false, message: 'Transaction has already been fully refunded' })
        return
      }
      respondJson(res, 200, { status: true, data: { id: 99, status: 'pending' } })
    })

    const { world, store } = makeWorld()
    const args = {
      store,
      env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: stub.url },
      rideId: RIDE_ID,
      reason: 'student_cancelled',
      actor: { id: STUDENT_ID, role: 'student' },
    }

    const failed = await performRefund(args)

    expect(failed.status).toBe(502)
    expect(failed.body.refund_status).toBe('failed')
    expect(world.payment.refund_status).toBe('failed')
    expect(world.payment.refund_needs_attention).toBe(true)
    // The money did NOT come back, so the ride must not look refunded.
    expect(world.ride.status).toBe('paid')
    expect(world.payment.status).toBe('success')
    expect(world.events.some((e) => e.event === 'refund_failed')).toBe(true)

    // A definite rejection created no provider refund, so retrying is safe.
    expect(isRefundClaimable(world.payment)).toBe(true)
    const retried = await performRefund(args)
    expect(retried.status).toBe(200)
    expect(stub.requests).toHaveLength(2)
    expect(world.payment.refund_reference).toBe('99')
  })

  it('treats a timeout as uncertain: flags it and never retries automatically', async () => {
    const stub = await startPaystackStub((request, res) => {
      setTimeout(() => {
        respondJson(res, 200, { status: true, data: { id: 123, status: 'pending' } })
      }, 400)
    })

    const { world, store } = makeWorld()
    const args = {
      store,
      env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: stub.url },
      rideId: RIDE_ID,
      timeoutMs: 60,
    }

    const result = await performRefund(args)
    expect(result.status).toBe(502)
    expect(result.body.needs_attention).toBe(true)
    expect(world.payment.refund_status).toBe('pending')
    expect(world.payment.refund_needs_attention).toBe(true)
    expect(world.ride.status).toBe('paid')
    expect(world.events.some((e) => e.event === 'refund_unconfirmed')).toBe(true)

    const again = await performRefund(args)
    expect(again.body.already_refunded).toBe(true)
    expect(stub.requests).toHaveLength(1)
  })

  it('routes a cash payment to manual reconciliation with no Paystack call', async () => {
    const stub = await startPaystackStub((request, res) => {
      respondJson(res, 200, { status: true, data: { id: 1, status: 'pending' } })
    })

    const { world, store } = makeWorld({
      payment: { method: 'cash' },
    })

    const result = await performRefund({
      store,
      env: { PAYSTACK_SECRET_KEY: SECRET, PAYSTACK_API_BASE: stub.url },
      rideId: RIDE_ID,
    })

    expect(result.status).toBe(409)
    expect(result.body.payment_method).toBe('cash')
    expect(stub.requests).toHaveLength(0)
    expect(world.payment.refund_status).toBeNull()
    expect(world.events[0].event).toBe('refund_blocked_cash')
  })
})


describe('webhook signature gate', () => {
  const rawBody = JSON.stringify({
    event: 'refund.processed',
    data: { id: 5, transaction: { reference: 'DF-paystack-ref-1' } },
  })

  it('accepts a genuine HMAC SHA-512 signature', async () => {
    const signature = await signWebhookBody(rawBody, SECRET)
    await expect(verifyPaystackSignature({ rawBody, signature, secret: SECRET }))
      .resolves.toBe(true)
  })

  it('rejects a forged or missing signature', async () => {
    await expect(verifyPaystackSignature({ rawBody, signature: undefined, secret: SECRET }))
      .resolves.toBe(false)
    await expect(verifyPaystackSignature({ rawBody, signature: '', secret: SECRET }))
      .resolves.toBe(false)
    await expect(verifyPaystackSignature({ rawBody, signature: 'deadbeef', secret: SECRET }))
      .resolves.toBe(false)

    const signature = await signWebhookBody(rawBody, 'sk_attacker')
    await expect(verifyPaystackSignature({ rawBody, signature, secret: SECRET }))
      .resolves.toBe(false)
  })

  it('rejects a signature that does not match the body', async () => {
    const signature = await signWebhookBody(rawBody, SECRET)
    const tampered = rawBody.replace('"id":5', '"id":6')
    await expect(verifyPaystackSignature({ rawBody: tampered, signature, secret: SECRET }))
      .resolves.toBe(false)
  })
})

describe('refund webhooks', () => {
  it('confirms refund.processed: payment refunded, ride refunded, event recorded', async () => {
    const { world, store } = makeWorld({
      ride: { status: 'refunded' },
      payment: {
        refund_status: 'pending',
        refund_reference: '987654',
        refund_needs_attention: true,
        refund_last_error: 'previous timeout',
      },
    })

    const outcome = await applyRefundWebhook({
      store,
      event: 'refund.processed',
      data: {
        id: 987654,
        status: 'processed',
        transaction: { reference: 'DF-paystack-ref-1' },
      },
      now: '2026-11-24T13:00:00.000Z',
    })

    expect(outcome).toMatchObject({ handled: true, refund_status: 'processed' })
    expect(world.payment.refund_status).toBe('processed')
    expect(world.payment.status).toBe('refunded')
    expect(world.payment.refunded_at).toBe('2026-11-24T13:00:00.000Z')
    expect(world.payment.refund_needs_attention).toBe(false)
    expect(world.events.filter((e) => e.event === 'refund_processed')).toHaveLength(1)

    // A replayed webhook is acknowledged without a second audit row.
    const replay = await applyRefundWebhook({
      store,
      event: 'refund.processed',
      data: { id: 987654, transaction: { reference: 'DF-paystack-ref-1' } },
    })
    expect(replay.already).toBe(true)
    expect(world.events.filter((e) => e.event === 'refund_processed')).toHaveLength(1)
  })

  it('confirms an accepted refund on a ride that is still paid', async () => {
    const { world, store } = makeWorld({
      ride: { status: 'paid' },
      payment: { refund_status: 'pending', refund_reference: '77' },
    })

    const outcome = await applyRefundWebhook({
      store,
      event: 'refund.processed',
      data: { id: 77, transaction: { reference: 'DF-paystack-ref-1' } },
    })

    expect(outcome.refund_status).toBe('processed')
    expect(world.ride.status).toBe('refunded')
    expect(world.payment.status).toBe('refunded')
  })

  it('handles refund.failed without leaving the ride looking refunded', async () => {
    const { world, store } = makeWorld({
      ride: { status: 'refunded' },
      payment: { refund_status: 'pending', refund_reference: '1234' },
    })

    const outcome = await applyRefundWebhook({
      store,
      event: 'refund.failed',
      data: {
        id: 1234,
        status: 'failed',
        reason: 'Insufficient provider balance',
        transaction: { reference: 'DF-paystack-ref-1' },
      },
    })

    expect(outcome).toMatchObject({
      handled: true,
      refund_status: 'failed',
      needs_attention: true,
      ride_status: 'cancelled',
    })
    expect(world.payment.refund_status).toBe('failed')
    expect(world.payment.refund_needs_attention).toBe(true)
    expect(world.payment.refund_last_error).toBe('Insufficient provider balance')
    // The money did not come back: the payment is successful again and the
    // booking is not presented as refunded.
    expect(world.payment.status).toBe('success')
    expect(world.ride.status).toBe('cancelled')

    const event = world.events.find((e) => e.event === 'refund_failed')
    expect(event).toBeTruthy()
    expect(event.reason).toBe('Insufficient provider balance')
    expect(event.metadata.needs_attention).toBe(true)
  })

  it('ignores a refund webhook for a reference it never created', async () => {
    const { world, store } = makeWorld()

    const outcome = await applyRefundWebhook({
      store,
      event: 'refund.processed',
      data: { id: 1, transaction: { reference: 'DF-does-not-exist' } },
    })

    expect(outcome).toEqual({ handled: true, ignored: 'unknown_reference' })
    expect(world.payment.refund_status).toBeNull()
  })

  it('ignores event types that are not refund outcomes', async () => {
    const { store } = makeWorld()
    const outcome = await applyRefundWebhook({
      store,
      event: 'charge.success',
      data: { reference: 'DF-paystack-ref-1' },
    })
    expect(outcome).toEqual({ handled: false })
  })
})
