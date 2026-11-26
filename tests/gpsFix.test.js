import { describe, expect, it } from 'vitest'
import { preferFix } from '../src/lib/tracking.js'

// preferFix — the student blue-dot accuracy filter (useGeolocation).
// A much worse fix that has barely moved must NEVER drag the dot; a more
// accurate one, real movement, or an old previous fix must always update.

function fix(lat, lng, accuracy, timestamp = Date.now()) {
  return { lat, lng, accuracy, timestamp }
}

describe('preferFix', () => {
  it('accepts the first fix', () => {
    expect(preferFix(null, fix(9.29, 7.41, 30))).toBe(true)
  })

  it('rejects an absent fix', () => {
    expect(preferFix(fix(9.29, 7.41, 30), null)).toBe(false)
  })

  it('accepts an equal or better accuracy fix', () => {
    const prev = fix(9.29, 7.41, 30)
    expect(preferFix(prev, fix(9.29, 7.41, 30))).toBe(true)
    expect(preferFix(prev, fix(9.29, 7.41, 12))).toBe(true)
  })

  it('ignores a much-worse fix that has barely moved (GPS noise under a roof)', () => {
    const prev = fix(9.29, 7.41, 15)
    // accuracy 200 m vs 15 m, ~1 m of movement
    expect(preferFix(prev, fix(9.29001, 7.41001, 200))).toBe(false)
  })

  it('accepts real movement even when accuracy degrades', () => {
    const prev = fix(9.29, 7.41, 15)
    // ~22 m north with a much worse circle — movement is new information
    expect(preferFix(prev, fix(9.2902, 7.41, 120))).toBe(true)
  })

  it('accepts a much-worse fix once the previous one is stale (no frozen dot)', () => {
    const prev = fix(9.29, 7.41, 15, Date.now() - 60000)
    expect(preferFix(prev, fix(9.29, 7.41, 300))).toBe(true)
  })

  it('accepts mild accuracy jitter (normal GPS noise, not "much worse")', () => {
    const prev = fix(9.29, 7.41, 20)
    expect(preferFix(prev, fix(9.29, 7.41, 35))).toBe(true)
  })

  it('accepts when accuracy is unknown rather than blocking the dot forever', () => {
    const prev = fix(9.29, 7.41, null)
    expect(preferFix(prev, fix(9.29, 7.41, 150))).toBe(true)
    const prevNoAcc = fix(9.29, 7.41, 15)
    expect(preferFix(prevNoAcc, fix(9.29, 7.41, null))).toBe(true)
  })
})
