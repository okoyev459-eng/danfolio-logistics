import { describe, expect, it } from 'vitest'
import {
  OFFLINE_INTERVAL_MS,
  RECONNECT_CAP_MS,
  SLOW_APPLY_INTERVAL_MS,
  applyIntervalMs,
  connectionQuality,
  networkBanner,
  nextRetryDelay,
  pollIntervalMs,
  shouldApplyPosition,
} from '../src/lib/netQuality.js'

// Adaptive update-rate rules for a poor school network (field-test fix-pack):
// fast = realtime as it arrives, slow = one position every 5–8 s, offline =
// nothing at all (the cached position stays, labelled with its age).

describe('connectionQuality', () => {
  it('reports offline when the browser says so', () => {
    expect(connectionQuality({ onLine: false, connection: { effectiveType: '4g' } })).toBe(
      'offline',
    )
  })

  it('treats 2g / 3g / slow-2g as slow', () => {
    for (const effectiveType of ['slow-2g', '2g', '3g']) {
      expect(connectionQuality({ onLine: true, connection: { effectiveType } })).toBe('slow')
    }
  })

  it('respects Save-Data even on a fast link', () => {
    expect(
      connectionQuality({ onLine: true, connection: { effectiveType: '4g', saveData: true } }),
    ).toBe('slow')
  })

  it('treats 4g and unknown/hidden connections as fast', () => {
    expect(connectionQuality({ onLine: true, connection: { effectiveType: '4g' } })).toBe('fast')
    expect(connectionQuality({ onLine: true })).toBe('fast')
    expect(connectionQuality(null)).toBe('fast')
  })
})

describe('adaptive update rate', () => {
  it('applies every update on a healthy connection', () => {
    expect(applyIntervalMs('fast')).toBe(0)
    expect(shouldApplyPosition({ now: 1000, lastAt: 999, quality: 'fast' })).toBe(true)
  })

  it('applies at most one position every 5–8 s on a slow connection', () => {
    expect(SLOW_APPLY_INTERVAL_MS).toBeGreaterThanOrEqual(5000)
    expect(SLOW_APPLY_INTERVAL_MS).toBeLessThanOrEqual(8000)

    const lastAt = 1_700_000_000_000
    expect(shouldApplyPosition({ now: lastAt + 2000, lastAt, quality: 'slow' })).toBe(false)
    expect(shouldApplyPosition({ now: lastAt + 5000, lastAt, quality: 'slow' })).toBe(false)
    expect(shouldApplyPosition({ now: lastAt + 6000, lastAt, quality: 'slow' })).toBe(true)
  })

  it('applies the first position immediately even on a slow link', () => {
    expect(shouldApplyPosition({ now: 1000, lastAt: 0, quality: 'slow' })).toBe(true)
  })

  it('never applies a position while offline', () => {
    expect(applyIntervalMs('offline')).toBe(OFFLINE_INTERVAL_MS)
    expect(shouldApplyPosition({ now: 999_999, lastAt: 0, quality: 'offline' })).toBe(false)
    expect(shouldApplyPosition({ now: 999_999, lastAt: 1, quality: 'offline' })).toBe(false)
  })

  it('polls slower on a weak link and not at all offline', () => {
    expect(pollIntervalMs('fast')).toBeGreaterThan(0)
    expect(pollIntervalMs('slow')).toBeGreaterThanOrEqual(pollIntervalMs('fast'))
    expect(pollIntervalMs('offline')).toBeNull()
  })
})

describe('nextRetryDelay', () => {
  it('backs off exponentially and caps at 30 s', () => {
    expect(nextRetryDelay(0)).toBe(1000)
    expect(nextRetryDelay(1)).toBe(2000)
    expect(nextRetryDelay(2)).toBe(4000)
    expect(nextRetryDelay(3)).toBe(8000)
    expect(nextRetryDelay(4)).toBe(16000)
    expect(nextRetryDelay(5)).toBe(30000)
    expect(nextRetryDelay(50)).toBe(RECONNECT_CAP_MS)
    expect(RECONNECT_CAP_MS).toBe(30000)
  })

  it('is safe with a nonsense attempt count', () => {
    expect(nextRetryDelay(-3)).toBe(1000)
    expect(nextRetryDelay(undefined)).toBe(1000)
  })
})

describe('networkBanner', () => {
  it('is calm, short and absent on a healthy connection', () => {
    expect(networkBanner('fast')).toBe('')
    expect(networkBanner('slow')).toBe('Weak network, updating slowly.')
    expect(networkBanner('offline')).toBe(
      'You’re offline. Showing last known position.',
    )
  })
})
