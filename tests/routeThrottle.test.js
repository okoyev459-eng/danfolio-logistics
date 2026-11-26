import { describe, expect, it } from 'vitest'
import {
  LIVE_REROUTE_INTERVAL_MS,
  LIVE_REROUTE_MIN_MOVE_M,
  shouldRerouteLive,
} from '../src/lib/routing.js'

// Live-route throttle (field-test fix-pack): even a fast-moving rider must not
// trigger one routing request per GPS tick. A re-route needs BOTH 10 s since
// the last request AND 40 m of real movement.

const T0 = 1_700_000_000_000
const ORIGIN = { lat: 9.29, lng: 7.41 }
// ~55 m north (1 deg lat ≈ 111_320 m).
const MOVED_55M = { lat: 9.29 + 55 / 111_320, lng: 7.41 }
// ~2 m — GPS jitter.
const JITTER = { lat: 9.29 + 2 / 111_320, lng: 7.41 }

describe('shouldRerouteLive', () => {
  it('uses a 10 s interval and a 40 m movement threshold', () => {
    expect(LIVE_REROUTE_INTERVAL_MS).toBe(10000)
    expect(LIVE_REROUTE_MIN_MOVE_M).toBe(40)
  })

  it('routes the first time (nothing has been routed yet)', () => {
    expect(
      shouldRerouteLive({ current: ORIGIN, lastOrigin: null, now: T0, lastAt: 0 }),
    ).toBe(true)
  })

  it('refuses a re-route inside the 10 s window, even after a big move', () => {
    expect(
      shouldRerouteLive({
        current: MOVED_55M,
        lastOrigin: ORIGIN,
        now: T0 + 9000,
        lastAt: T0,
      }),
    ).toBe(false)
  })

  it('refuses a re-route after 10 s when the rider has not moved 40 m', () => {
    expect(
      shouldRerouteLive({ current: JITTER, lastOrigin: ORIGIN, now: T0 + 20000, lastAt: T0 }),
    ).toBe(false)
  })

  it('re-routes once BOTH conditions are met', () => {
    expect(
      shouldRerouteLive({ current: MOVED_55M, lastOrigin: ORIGIN, now: T0 + 10000, lastAt: T0 }),
    ).toBe(true)
  })

  it('never re-routes without a usable current coordinate', () => {
    expect(
      shouldRerouteLive({ current: null, lastOrigin: ORIGIN, now: T0 + 60000, lastAt: T0 }),
    ).toBe(false)
    expect(
      shouldRerouteLive({
        current: { lat: 0, lng: 0 },
        lastOrigin: ORIGIN,
        now: T0 + 60000,
        lastAt: T0,
      }),
    ).toBe(false)
  })

  it('honours explicit threshold overrides', () => {
    expect(
      shouldRerouteLive({
        current: MOVED_55M,
        lastOrigin: ORIGIN,
        now: T0 + 1000,
        lastAt: T0,
        minIntervalMs: 500,
        minMeters: 10,
      }),
    ).toBe(true)
  })
})
