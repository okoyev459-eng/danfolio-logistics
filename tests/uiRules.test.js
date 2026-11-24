import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {
  BOOKING_SHEET_SNAPS,
  isDuplicateReviewError,
  isIosInstallDevice,
  isStandaloneDisplay,
  resendLabel,
  resendSecondsRemaining,
  shouldOfferRating,
  visibleMapFraction,
} from '../src/lib/uiRules.js'

const cacheRulesSource = fs.readFileSync(
  path.resolve(process.cwd(), 'public/cache-rules.js'),
  'utf8'
)
const sandbox = { self: {} }
vm.runInNewContext(cacheRulesSource, sandbox)
const { isSafeStaticRequest, isBlockedRequestPath } = sandbox.self.danfolioCacheRules

describe('booking sheet visibility', () => {
  it('keeps more than half the map visible when collapsed', () => {
    expect(BOOKING_SHEET_SNAPS[0]).toBeLessThan(0.5)
    expect(visibleMapFraction(BOOKING_SHEET_SNAPS[0])).toBeGreaterThan(0.5)
  })

  it('has clear ascending snap points', () => {
    expect(BOOKING_SHEET_SNAPS).toEqual([0.28, 0.54, 0.88])
  })
})

describe('rating prompt rules', () => {
  it('offers rating only for completed rides without existing review', () => {
    expect(shouldOfferRating('completed', false)).toBe(true)
    expect(shouldOfferRating('completed', true)).toBe(false)
    expect(shouldOfferRating('cancelled', false)).toBe(false)
    expect(shouldOfferRating('refunded', false)).toBe(false)
    expect(shouldOfferRating('on_trip', false)).toBe(false)
  })

  it('treats uniqueness conflicts as duplicate review submissions', () => {
    expect(isDuplicateReviewError({ code: '23505' })).toBe(true)
    expect(isDuplicateReviewError({ message: 'duplicate key value violates unique constraint' })).toBe(true)
    expect(isDuplicateReviewError({ code: '42501' })).toBe(false)
  })
})

describe('resend countdown', () => {
  it('counts down to zero and formats labels', () => {
    expect(resendSecondsRemaining(10_500, 10_000)).toBe(1)
    expect(resendSecondsRemaining(10_000, 10_500)).toBe(0)
    expect(resendLabel(12, 'Resend reset link')).toBe('Resend in 12s')
    expect(resendLabel(0, 'Resend reset link')).toBe('Resend reset link')
  })
})

describe('PWA install detection', () => {
  it('detects iOS/iPadOS install surfaces', () => {
    expect(isIosInstallDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(true)
    expect(isIosInstallDevice({ platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true)
    expect(isIosInstallDevice({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', platform: 'Win32' })).toBe(false)
  })

  it('detects standalone display mode', () => {
    expect(isStandaloneDisplay({ standalone: true })).toBe(true)
    expect(isStandaloneDisplay({ displayMode: 'standalone' })).toBe(true)
    expect(isStandaloneDisplay({ displayMode: 'browser' })).toBe(false)
  })
})

describe('service worker cache safety', () => {
  it('allows only safe static assets', () => {
    expect(isSafeStaticRequest('/assets/index-abc.js')).toBe(true)
    expect(isSafeStaticRequest('/icons/icon-192.png')).toBe(true)
    expect(isSafeStaticRequest('/manifest.webmanifest')).toBe(true)
    expect(isSafeStaticRequest('/favicon.svg')).toBe(true)
    expect(isSafeStaticRequest('/robots.txt')).toBe(true)
    expect(isSafeStaticRequest('/some-unexpected.js')).toBe(false)
  })

  it('never caches auth, supabase data, payment, or private routes', () => {
    expect(isSafeStaticRequest('/auth/v1/token')).toBe(false)
    expect(isSafeStaticRequest('/rest/v1/rides')).toBe(false)
    expect(isSafeStaticRequest('/functions/v1/start-payment')).toBe(false)
    expect(isSafeStaticRequest('/storage/v1/object/public/avatars/a.png')).toBe(false)
    expect(isSafeStaticRequest('/api/paystack-webhook')).toBe(false)
    expect(isSafeStaticRequest('/sw.js')).toBe(false)
  })

  it('blocks protected navigation-style paths from app shell caching', () => {
    expect(isBlockedRequestPath('/auth/v1/callback')).toBe(true)
    expect(isBlockedRequestPath('/rest/v1/rides')).toBe(true)
    expect(isBlockedRequestPath('/functions/v1/start-payment')).toBe(true)
    expect(isBlockedRequestPath('/api/internal')).toBe(true)
    expect(isBlockedRequestPath('/student')).toBe(false)
  })
})
