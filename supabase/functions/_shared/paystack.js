// Paystack provider access shared by the refund path and the webhook.
//
// PAYSTACK_API_BASE exists so tests can point at a local stub server and
// prove the refund flow WITHOUT ever touching the live Paystack API. It
// defaults to the real API, so production behaviour is unchanged when the
// variable is unset.

export const PAYSTACK_DEFAULT_BASE = 'https://api.paystack.co'

export function paystackBaseUrl(env = {}) {
  const configured = typeof env.PAYSTACK_API_BASE === 'string'
    ? env.PAYSTACK_API_BASE.trim()
    : ''
  const base = configured || PAYSTACK_DEFAULT_BASE

  let url
  try {
    url = new URL(base)
  } catch {
    throw new Error('PAYSTACK_API_BASE must be an absolute http(s) URL.')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('PAYSTACK_API_BASE must be an absolute http(s) URL.')
  }

  return `${url.origin}${url.pathname}`.replace(/\/+$/, '')
}

// Paystack refunds are FULL refunds: the amount is deliberately omitted so the
// provider returns the whole transaction. Never send an amount here — the
// fare + service fee split must not change what the student gets back.
export function refundRequestBody({ payment, rideId, reason }) {
  return {
    transaction: payment.paystack_ref,
    currency: 'NGN',
    customer_note: 'Refund for a cancelled Danfolio Logistics ride.',
    merchant_note:
      `Danfolio Logistics refund for ride ${rideId}` +
      (reason ? ` (${reason})` : ''),
  }
}

export function refundStatusFromProvider(value) {
  const status = typeof value === 'string' ? value.toLowerCase() : ''
  if (status === 'processed' || status === 'success' || status === 'successful') {
    return 'processed'
  }
  if (status === 'failed' || status === 'reversed') return 'failed'
  // 'pending', 'processing', 'queued', anything unknown: not confirmed yet.
  return 'pending'
}

// Performs ONE refund request against Paystack and classifies the outcome.
//
//   accepted  — the provider created a refund (id + status in the response)
//   rejected  — a definite provider refusal; NO refund exists, so a retry is safe
//   uncertain — timeout/network error; the refund MAY exist, so never auto-retry
export async function requestRefund({
  env,
  fetchImpl,
  payment,
  rideId,
  reason,
  timeoutMs = 20000,
}) {
  const url = `${paystackBaseUrl(env)}/refund`

  let response
  try {
    response = await (fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(refundRequestBody({ payment, rideId, reason })),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return {
      state: 'uncertain',
      detail: error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? 'Paystack did not answer the refund request in time.'
        : 'The refund request could not reach Paystack.',
    }
  }

  const result = await response.json().catch(() => null)

  if (!response.ok || !result?.status || !result?.data) {
    return {
      state: 'rejected',
      httpStatus: response.status,
      message: result?.message || 'Paystack could not initiate the refund.',
    }
  }

  const status = refundStatusFromProvider(result.data.status)
  if (status === 'failed') {
    return {
      state: 'rejected',
      httpStatus: 502,
      message: result.data.message || 'Paystack reported the refund failed.',
    }
  }

  return {
    state: 'accepted',
    reference: result.data.id !== undefined && result.data.id !== null
      ? String(result.data.id)
      : null,
    status,
    providerStatus: typeof result.data.status === 'string' ? result.data.status : null,
  }
}

function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false

  let difference = 0
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }

  return difference === 0
}

export async function signWebhookBody(rawBody, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  )

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  )

  return Array.from(new Uint8Array(signature))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

// The ONLY gate that makes a refund webhook trustworthy. A missing or forged
// signature must always fail, so a caller who knows a payment reference can
// never flip a payment to refunded/failed.
export async function verifyPaystackSignature({ rawBody, signature, secret }) {
  if (!secret || typeof signature !== 'string' || !signature) return false
  const expected = await signWebhookBody(rawBody, secret)
  return constantTimeEqual(signature.toLowerCase(), expected)
}
