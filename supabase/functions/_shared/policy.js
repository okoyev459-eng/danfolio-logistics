// Shared Danfolio policy — ONE source of truth for the numbers and rules
// that both the Supabase Edge Functions (Deno) and the Vite/React app must
// agree on. Plain ESM with no Deno or browser globals, so it is imported by:
//
//   * supabase/functions/*/index.ts        (Deno resolves the relative path)
//   * src/pages/**, src/lib/**             (Vite/Rollup bundles it)
//   * tests/*.test.js                      (vitest)
//
// The SQL side of the same rules lives in
//   supabase/migrations/20261117090000_rider_cancellation_breakdown.sql
// and is deliberately kept in step with the constants below (tests/
// policy.test.js reads that file and fails if the two drift apart).

// ---------------------------------------------------------------------
// Commission: a FIXED ₦20 service fee added ON TOP of the agreed fare.
//
//   student pays   = rides.fare + SERVICE_FEE_NGN   (one Paystack charge)
//   rider receives = rides.fare                     (their agreed fare)
//   platform keeps = SERVICE_FEE_NGN - provider fee
//
// Nothing here is ever subtracted from what the rider is owed, and the fee
// is never charged twice: start-payment charges exactly one amount per ride
// and refuses to open a second attempt while one is pending or settled.
// ---------------------------------------------------------------------
export const SERVICE_FEE_NGN = 20

// A keke carries THREE passengers, excluding the rider. This mirrors
// `keke_active_ride_count() < 3` in dispatch_next_ride_request() and the
// `>= 3` capacity gate in respond_to_ride_request().
export const MAX_ACTIVE_RIDES = 3

// How long an offer stays open before dispatch rotates it to the next keke.
export const OFFER_TTL_SECONDS = 15

// ---------------------------------------------------------------------
// Ride-incident policy (rider cancellation / breakdown handling).
// ---------------------------------------------------------------------

// Pre-boarding: the student has not boarded yet, so the booking can be
// handed to another keke without stranding anyone.
export const REDISPATCHABLE_STATUSES = ['searching', 'accepted', 'paid', 'arrived']

// Post-boarding: the student IS in the keke. A breakdown here is an
// INTERRUPTED trip — never an ordinary cancellation.
export const INTERRUPTABLE_STATUSES = ['on_trip']

export const INCIDENT_REASONS = ['cancelled', 'breakdown', 'emergency']

// What the rider (or an admin) may ask for, given the ride's current state.
// Pure predicates — the authoritative enforcement lives server-side in
// rider-cancel-ride; these only decide which controls the UI offers.
export function canRedispatch(status) {
  return REDISPATCHABLE_STATUSES.includes(String(status ?? ''))
}

export function canInterrupt(status, interruptedAt) {
  return (
    INTERRUPTABLE_STATUSES.includes(String(status ?? '')) &&
    !interruptedAt
  )
}

// A replacement may only be arranged for a trip that is actually
// interrupted and has not already been replaced.
export function canArrangeReplacement(interruptedAt, replacementAt) {
  return Boolean(interruptedAt) && !replacementAt
}

// An interrupted trip is still in progress — the student must not be able
// to book another ride while stranded, and the seat stays held.
export function isActiveStatus(status) {
  return REDISPATCHABLE_STATUSES.includes(String(status ?? '')) ||
    String(status ?? '') === 'on_trip'
}

// ---------------------------------------------------------------------
// Money helpers.
// ---------------------------------------------------------------------

export function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0
}

// What the student is charged for a ride of `fareNaira`.
export function rideTotal(fareNaira, serviceFeeNaira = SERVICE_FEE_NGN) {
  if (!isPositiveInt(fareNaira) || !isPositiveInt(serviceFeeNaira)) return null
  return fareNaira + serviceFeeNaira
}

// Danfolio's take before provider fees.
export function platformFee(serviceFeeNaira = SERVICE_FEE_NGN) {
  return isPositiveInt(serviceFeeNaira) ? serviceFeeNaira : 0
}

// Provider (Paystack) processing fee — an ESTIMATE used only for the
// auditable transaction history. It never changes what the student is
// charged, what the rider is owed, or what is refunded.
//
// The rate parameters are configurable because Paystack's published rates
// differ by channel and change over time; verify them against your own
// Paystack dashboard. The estimate is always recorded with
// `estimated: true` and the parameters that produced it.
export function estimateProviderFee(amountNaira, {
  percent = 1.5,
  capNaira = 2000,
  fixedNaira = 0,
} = {}) {
  if (!isPositiveInt(amountNaira)) return null
  const pctFee = (amountNaira * Number(percent)) / 100
  const raw = pctFee + Number(fixedNaira || 0)
  const capped = Number(capNaira) > 0 ? Math.min(raw, Number(capNaira)) : raw
  return {
    amount_naira: Math.round(capped * 100) / 100,
    estimated: true,
    model: {
      percent: Number(percent),
      fixed_naira: Number(fixedNaira || 0),
      cap_naira: Number(capNaira) || null,
    },
  }
}

// Net platform margin after the provider takes its cut. Reported, never
// used to move money.
export function platformMargin({
  serviceFeeNaira = SERVICE_FEE_NGN,
  chargedNaira = null,
  percent = 1.5,
  capNaira = 2000,
  fixedNaira = 0,
} = {}) {
  const fee = platformFee(serviceFeeNaira)
  if (!isPositiveInt(chargedNaira)) {
    return { service_fee_naira: fee, provider_fee: null, net_naira: null }
  }
  const provider = estimateProviderFee(chargedNaira, { percent, capNaira, fixedNaira })
  return {
    service_fee_naira: fee,
    provider_fee: provider,
    net_naira: Math.round((fee - provider.amount_naira) * 100) / 100,
  }
}

// Which payments actually moved money electronically. A cash payment never
// reached Paystack, so it must NEVER be sent to the refund endpoint —
// refunding it there would fail (or worse, refund an unrelated charge).
export const DIGITAL_METHODS = ['card', 'transfer']
export const PAYMENT_METHODS = ['card', 'transfer', 'cash']

export function isDigitalMethod(method) {
  return DIGITAL_METHODS.includes(String(method ?? ''))
}

// TRUE only for a payment we KNOW was collected as cash. Rows written
// before payments.method existed have method = NULL and were all Paystack
// charges, so NULL is treated as digital (see the migration comment) —
// only an explicit 'cash' is ever blocked from the refund endpoint.
export function isCashMethod(method) {
  return String(method ?? '') === 'cash'
}
