import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  DIGITAL_METHODS,
  INCIDENT_REASONS,
  INTERRUPTABLE_STATUSES,
  MAX_ACTIVE_RIDES,
  OFFER_TTL_SECONDS,
  PAYMENT_METHODS,
  REDISPATCHABLE_STATUSES,
  SERVICE_FEE_NGN,
  canArrangeReplacement,
  canInterrupt,
  canRedispatch,
  estimateProviderFee,
  isActiveStatus,
  isCashMethod,
  isDigitalMethod,
  isPositiveInt,
  platformFee,
  platformMargin,
  rideTotal,
} from '../supabase/functions/_shared/policy.js'

// policy.test.js — the single source of truth for money, capacity and
// incident rules, PLUS a drift-check against the migration file and the
// call sites. If someone edits the SQL capacity (or hardcodes the fee in a
// function/UI), these tests fail instead of the app silently diverging.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
}

const MIGRATION = read(
  'supabase/migrations/20261117090000_rider_cancellation_breakdown.sql',
)
const START_PAYMENT = read('supabase/functions/start-payment/index.ts')
const WEBHOOK = read('supabase/functions/paystack-webhook/index.ts')
const KEEKE_HOME = read('src/pages/keke/Home.jsx')
const PAY_RIDE = read('src/pages/student/PayRide.jsx')
const BOOK_FLOW = read('src/pages/student/BookFlow.jsx')

// SQL lines with comments stripped, so an explanatory "-- capacity 4 -> 3"
// comment can never mask a real capacity-4 gate (or vice versa).
const sqlCode = MIGRATION.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')

describe('shared constants', () => {
  it('charges a fixed ₦20 service fee on top of the fare', () => {
    expect(SERVICE_FEE_NGN).toBe(20)
  })

  it('carries THREE passengers per keke, excluding the rider', () => {
    expect(MAX_ACTIVE_RIDES).toBe(3)
  })

  it('holds an offer open for 15 seconds', () => {
    expect(OFFER_TTL_SECONDS).toBe(15)
  })

  it('names the exact incident reasons the UI and function accept', () => {
    expect(INCIDENT_REASONS).toEqual(['cancelled', 'breakdown', 'emergency'])
    expect(INTERRUPTABLE_STATUSES).toEqual(['on_trip'])
    expect(REDISPATCHABLE_STATUSES).toEqual(['searching', 'accepted', 'paid', 'arrived'])
  })
})

describe('incident predicates', () => {
  it('allows redispatch only BEFORE boarding', () => {
    for (const status of REDISPATCHABLE_STATUSES) {
      expect(canRedispatch(status)).toBe(true)
    }
    expect(canRedispatch('on_trip')).toBe(false)
    expect(canRedispatch('completed')).toBe(false)
    expect(canRedispatch('cancelled')).toBe(false)
    expect(canRedispatch('refunded')).toBe(false)
  })

  it('allows interruption only ON a trip that is not already interrupted', () => {
    expect(canInterrupt('on_trip', null)).toBe(true)
    expect(canInterrupt('on_trip', undefined)).toBe(true)
    expect(canInterrupt('on_trip', '2026-11-17T10:00:00Z')).toBe(false)
    expect(canInterrupt('accepted', null)).toBe(false)
    expect(canInterrupt('arrived', null)).toBe(false)
    expect(canInterrupt('completed', null)).toBe(false)
  })

  it('lets an admin arrange a replacement exactly once', () => {
    // Only an actually-interrupted, not-yet-replaced trip qualifies.
    expect(canArrangeReplacement(null, null)).toBe(false)
    expect(canArrangeReplacement('2026-11-17T10:00:00Z', null)).toBe(true)
    expect(canArrangeReplacement(null, '2026-11-17T10:05:00Z')).toBe(false)
    expect(
      canArrangeReplacement('2026-11-17T10:00:00Z', '2026-11-17T10:05:00Z'),
    ).toBe(false)
  })

  it('recognises the active statuses the unique index protects', () => {
    for (const status of ['searching', 'accepted', 'paid', 'arrived', 'on_trip']) {
      expect(isActiveStatus(status)).toBe(true)
    }
    for (const status of ['completed', 'cancelled', 'refunded']) {
      expect(isActiveStatus(status)).toBe(false)
    }
  })
})

describe('money helpers', () => {
  it('adds fare + fee and rejects nonsense', () => {
    expect(rideTotal(500)).toBe(520)
    expect(rideTotal(500, 20)).toBe(520)
    expect(rideTotal(0)).toBeNull()
    expect(rideTotal(-5)).toBeNull()
    expect(rideTotal(500.5)).toBeNull()
    expect(rideTotal(500, 0)).toBeNull()
  })

  it('reports the platform fee only for a valid amount', () => {
    expect(platformFee()).toBe(20)
    expect(platformFee(35)).toBe(35)
    expect(platformFee(-1)).toBe(0)
    expect(isPositiveInt(20)).toBe(true)
    expect(isPositiveInt('20')).toBe(false)
  })

  it('estimates the provider fee with its cap and always flags the estimate', () => {
    const small = estimateProviderFee(1000) // 1.5% = ₦15
    expect(small.amount_naira).toBe(15)
    expect(small.estimated).toBe(true)

    const capped = estimateProviderFee(500_000) // 1.5% = ₦7500 → capped ₦2000
    expect(capped.amount_naira).toBe(2000)
    expect(capped.estimated).toBe(true)

    expect(estimateProviderFee(0)).toBeNull()
    expect(estimateProviderFee('100')).toBeNull()
  })

  it('reports the net margin without ever moving money', () => {
    // ₦20 fee − ₦15 estimated provider fee on a ₦1000 charge = ₦5 net.
    const margin = platformMargin({ chargedNaira: 1000 })
    expect(margin.service_fee_naira).toBe(20)
    expect(margin.provider_fee.amount_naira).toBe(15)
    expect(margin.net_naira).toBe(5)

    // Without a charged amount the provider part is honestly unknown.
    const unknown = platformMargin({})
    expect(unknown.provider_fee).toBeNull()
    expect(unknown.net_naira).toBeNull()
  })
})

describe('cash vs digital payment rules', () => {
  it('treats only card and transfer as digital', () => {
    expect(DIGITAL_METHODS).toEqual(['card', 'transfer'])
    expect(isDigitalMethod('card')).toBe(true)
    expect(isDigitalMethod('transfer')).toBe(true)
    expect(isDigitalMethod('cash')).toBe(false)
    // Legacy rows (method = NULL) were all Paystack charges — but they are
    // not *known* digital, only non-cash. The refund path keys off cash.
    expect(isDigitalMethod(null)).toBe(false)
  })

  it('blocks ONLY an explicit cash method from the Paystack refund path', () => {
    expect(PAYMENT_METHODS).toEqual(['card', 'transfer', 'cash'])
    expect(isCashMethod('cash')).toBe(true)
    expect(isCashMethod('card')).toBe(false)
    expect(isCashMethod('transfer')).toBe(false)
    expect(isCashMethod(null)).toBe(false)
    expect(isCashMethod(undefined)).toBe(false)
    expect(isCashMethod('CASH')).toBe(false)
  })
})

describe('drift-check: migration SQL matches policy.js', () => {
  it('dispatches with capacity 3 — no capacity-4 gate survives in code', () => {
    // The pool filter and the under-lock re-check in dispatch, plus the
    // accept gate in respond_to_ride_request.
    expect(sqlCode.match(/keke_active_ride_count\(k\.id\) < 3/g)?.length).toBeGreaterThanOrEqual(1)
    expect(sqlCode.match(/keke_active_ride_count\(.+?\)\s+>= 3/g)?.length).toBeGreaterThanOrEqual(2)

    // No live capacity-4 gate anywhere in executable SQL.
    expect(sqlCode).not.toMatch(/>=\s*4\b/)
    expect(sqlCode).not.toMatch(/<\s*4\b/)
    expect(sqlCode).not.toMatch(/int\s*:=\s*4\b/)
  })

  it('keeps the exact live function signatures (no accidental overload)', () => {
    expect(sqlCode).toMatch(
      /create or replace function public\.dispatch_next_ride_request\(p_ride_id uuid\)/,
    )
    expect(sqlCode).toMatch(
      /create or replace function public\.respond_to_ride_request\(p_request_id uuid, p_response request_response\)/,
    )
    // respond_to_ride_request must never grow a second overload.
    expect(sqlCode.match(/create or replace function public\.respond_to_ride_request/g)?.length).toBe(1)
    expect(sqlCode.match(/create or replace function public\.dispatch_next_ride_request/g)?.length).toBe(1)
  })

  it('carries the interruption columns and their CHECK (no new enum value)', () => {
    for (const col of [
      'interrupted_at',
      'interrupted_reason',
      'interrupted_lat',
      'interrupted_lng',
      'interrupted_accuracy',
      'replacement_at',
    ]) {
      expect(sqlCode).toContain(`add column if not exists ${col}`)
    }
    expect(sqlCode).toMatch(
      /interrupted_reason in \('cancelled', 'breakdown', 'emergency'\)/,
    )
    // Ride statuses stay the original enum — interruption is column-based.
    expect(sqlCode).not.toMatch(/alter type\s+ride_status\s+add value/i)
  })

  it('adds payments.method + service_fee with matching allowed values', () => {
    expect(sqlCode).toContain('add column if not exists method')
    expect(sqlCode).toContain('add column if not exists service_fee')

    const methodCheck = MIGRATION.match(
      /payments_method_check[\s\S]*?in \(([^)]+)\)/,
    )
    expect(methodCheck).not.toBeNull()
    const sqlMethods = methodCheck[1]
      .split(',')
      .map((s) => s.trim().replace(/'/g, ''))
    expect(sqlMethods).toEqual(PAYMENT_METHODS)
  })

  it('creates the append-only ride_events audit table with sane roles', () => {
    expect(sqlCode).toContain('create table if not exists public.ride_events')
    const roleCheck = MIGRATION.match(
      /actor_role\s+text not null default 'system'\s*check \(actor_role in \(([^)]+)\)\)/,
    )
    expect(roleCheck).not.toBeNull()
    const roles = roleCheck[1].split(',').map((s) => s.trim().replace(/'/g, ''))
    expect(roles).toEqual(['student', 'rider', 'admin', 'system'])
    // Read-only for clients: the ONLY policy on ride_events must be SELECT
    // (FOR UPDATE row locks elsewhere in the file are not policies).
    const eventPolicies = MIGRATION.match(/create policy[^;]*on public\.ride_events[^;]*;/gi) ?? []
    expect(eventPolicies.length).toBeGreaterThan(0)
    for (const policy of eventPolicies) {
      expect(policy).toMatch(/for select/i)
    }
  })

  it('guards double-booking with a DO-block unique index (race-safe)', () => {
    expect(sqlCode).toContain('create unique index rides_one_active_per_student')
    expect(sqlCode).toContain("when unique_violation then")
    expect(sqlCode).toMatch(
      /where status in \('searching', 'accepted', 'paid', 'arrived', 'on_trip'\)/,
    )
  })

  it('verifies the along fare route and prefers station-matched kekes', () => {
    // Along must never dispatch on proximity alone: the priced fare row has
    // to exist, and the station match is a sort key (preference), not a
    // hard filter that could strand rides when station_id is NULL.
    expect(sqlCode).toMatch(/f\.mode = 'along'[\s\S]{0,120}f\.from_id = v_from_id[\s\S]{0,80}f\.to_id = v_to_id/)
    expect(sqlCode).toMatch(/WHEN v_mode = 'along' AND k\.station_id = v_from_id THEN 0/)
  })

  it('records an audit row when dispatch auto-cancels an unfillable ride', () => {
    expect(sqlCode).toContain("'auto_cancelled'")
    expect(sqlCode).toContain("'no_ride_available'")
  })

  it('flips an already-successful payment to paid on accept (no double charge)', () => {
    expect(sqlCode).toMatch(/p\.ride_id = v_ride_id AND p\.status = 'success'/)
    expect(sqlCode).toContain("'ride_status'")
  })
})

describe('drift-check: call sites import the shared policy (no hardcoding)', () => {
  it('start-payment charges fare + SERVICE_FEE_NGN from policy.js', () => {
    expect(START_PAYMENT).toMatch(
      /import \{[^}]*SERVICE_FEE_NGN[^}]*\} from '\.\.\/_shared\/policy\.js'/,
    )
    expect(START_PAYMENT).toContain('rideTotal(fareNaira, SERVICE_FEE_NGN)')
    // The Paystack amount must come from the total, never the bare fare.
    expect(START_PAYMENT).not.toMatch(/amount:\s*String\(fareNaira \* 100\)/)
    expect(START_PAYMENT).toContain('amount: String(totalNaira * 100)')
    expect(START_PAYMENT).toContain('service_fee: SERVICE_FEE_NGN')
  })

  it('webhook derives method + fee audit from the shared helpers', () => {
    expect(WEBHOOK).toMatch(
      /import \{[^}]*estimateProviderFee[^}]*\} from '\.\.\/_shared\/policy\.js'/,
    )
    expect(WEBHOOK).toContain("'payment_verified'")
  })

  it('keke UI reads the seat count from policy.js (drift impossible)', () => {
    expect(KEEKE_HOME).toMatch(
      /import \{ MAX_ACTIVE_RIDES[^}]*\} from '\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/policy\.js'/,
    )
    // No hardcoded seat counts left in the rider UI.
    expect(KEEKE_HOME).not.toMatch(/of 4 rides|4\/4|\/4 seats|all 4 seats/)
  })

  it('student payment screens show the SAME fee the server charges', () => {
    for (const source of [PAY_RIDE, BOOK_FLOW]) {
      expect(source).toMatch(
        /import \{[^}]*SERVICE_FEE_NGN[^}]*\} from '.*_shared\/policy\.js'/,
      )
      expect(source).toContain('rideTotal(')
    }
  })
})
