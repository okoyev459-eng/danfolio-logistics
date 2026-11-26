import { describe, expect, it } from 'vitest'
import {
  RATE_LIMIT_COOLDOWN_SECONDS,
  RESEND_COOLDOWN_SECONDS,
  clearCooldown,
  cooldownKey,
  isResendBlocked,
  remainingSeconds,
  startCooldown,
} from '../src/lib/resendCooldown.js'

// A tiny sessionStorage stand-in, so the persistence rule (the DEADLINE is
// stored, not a countdown) is tested without a browser.
function fakeStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    size: () => map.size,
  }
}

const KEY = cooldownKey('forgot')
const T0 = 1_700_000_000_000

describe('resend cooldown', () => {
  it('uses a 60 s cooldown and a 5 min rate-limit lockout', () => {
    expect(RESEND_COOLDOWN_SECONDS).toBe(60)
    expect(RATE_LIMIT_COOLDOWN_SECONDS).toBe(300)
  })

  it('starts at 60 s and counts down', () => {
    const storage = fakeStorage()
    startCooldown(storage, KEY, RESEND_COOLDOWN_SECONDS, T0)

    expect(remainingSeconds(storage, KEY, T0)).toBe(60)
    expect(remainingSeconds(storage, KEY, T0 + 1000)).toBe(59)
    expect(remainingSeconds(storage, KEY, T0 + 15_000)).toBe(45)
    expect(remainingSeconds(storage, KEY, T0 + 59_000)).toBe(1)
  })

  it('unlocks exactly at the deadline and drops the stale entry', () => {
    const storage = fakeStorage()
    startCooldown(storage, KEY, RESEND_COOLDOWN_SECONDS, T0)

    expect(remainingSeconds(storage, KEY, T0 + 60_000)).toBe(0)
    expect(storage.getItem(KEY)).toBeNull()
    expect(isResendBlocked({ storage, key: KEY, now: T0 + 60_000 })).toBe(false)
  })

  it('persists across a refresh (a new reader of the same storage)', () => {
    const storage = fakeStorage()
    startCooldown(storage, KEY, RESEND_COOLDOWN_SECONDS, T0)

    // "Refresh": fresh component, same sessionStorage, real clock rewinds a
    // little — the wait must still be measured from the stored deadline.
    const afterRefresh = remainingSeconds(storage, KEY, T0 + 40_000)
    expect(afterRefresh).toBe(20)
    expect(isResendBlocked({ storage, key: KEY, now: T0 + 40_000 })).toBe(true)
  })

  it('locks for 5 minutes after a rate-limit response', () => {
    const storage = fakeStorage()
    startCooldown(storage, KEY, RATE_LIMIT_COOLDOWN_SECONDS, T0)

    expect(remainingSeconds(storage, KEY, T0 + 1000)).toBe(299)
    expect(remainingSeconds(storage, KEY, T0 + 4 * 60_000)).toBe(60)
    expect(remainingSeconds(storage, KEY, T0 + 5 * 60_000)).toBe(0)
  })

  it('is blocked while sending even with no cooldown stored', () => {
    const storage = fakeStorage()
    expect(isResendBlocked({ storage, key: KEY, now: T0, busy: true })).toBe(true)
    expect(isResendBlocked({ storage, key: KEY, now: T0, busy: false })).toBe(false)
  })

  it('keeps separate scopes apart (forgot vs signup)', () => {
    const storage = fakeStorage()
    const signup = cooldownKey('signup')
    startCooldown(storage, KEY, 300, T0)

    expect(remainingSeconds(storage, signup, T0)).toBe(0)
    expect(remainingSeconds(storage, KEY, T0)).toBe(300)
  })

  it('clears cleanly', () => {
    const storage = fakeStorage()
    startCooldown(storage, KEY, 60, T0)
    clearCooldown(storage, KEY)
    expect(remainingSeconds(storage, KEY, T0)).toBe(0)
    expect(storage.size()).toBe(0)
  })

  it('survives a missing or broken storage without throwing', () => {
    expect(remainingSeconds(null, KEY, T0)).toBe(0)
    expect(() => startCooldown(null, KEY, 60, T0)).not.toThrow()
    expect(isResendBlocked({ storage: null, key: KEY, now: T0 })).toBe(false)
  })
})
