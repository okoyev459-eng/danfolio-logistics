import { describe, expect, it } from 'vitest'
import {
  validCoord,
  distanceMeters,
  formatDistance,
  circlePolygon,
  nearestSnap,
} from '../src/lib/geo'

// The map renders a marker only for usable coordinates. Live data currently
// stores NULL coordinates everywhere, and 0,0 is the classic "unknown" trap
// (it sits in the Atlantic gulf of Guinea and would zoom the map to Africa).
describe('validCoord', () => {
  it('accepts real coordinates', () => {
    expect(validCoord({ lat: 8.4799, lng: 4.5226 })).toBe(true)
    expect(validCoord({ lat: '8.4799', lng: '4.5226' })).toBe(true)
  })

  it('rejects null / missing coordinates', () => {
    expect(validCoord({ lat: null, lng: null })).toBe(false)
    expect(validCoord({ lat: 8.4, lng: null })).toBe(false)
    expect(validCoord(null)).toBe(false)
    expect(validCoord(undefined)).toBe(false)
  })

  it('rejects the 0,0 placeholder', () => {
    expect(validCoord({ lat: 0, lng: 0 })).toBe(false)
  })

  it('rejects non-numeric values', () => {
    expect(validCoord({ lat: 'abc', lng: 4.5 })).toBe(false)
    expect(validCoord({})).toBe(false)
  })
})

describe('distanceMeters', () => {
  it('returns 0 for identical points', () => {
    expect(distanceMeters({ lat: 8.4799, lng: 4.5226 }, { lat: 8.4799, lng: 4.5226 })).toBe(0)
  })

  it('measures a known short campus distance within tolerance', () => {
    // ~111 m per 0.001° latitude anywhere on Earth.
    const d = distanceMeters({ lat: 8.4799, lng: 4.5226 }, { lat: 8.4809, lng: 4.5226 })
    expect(d).toBeGreaterThan(100)
    expect(d).toBeLessThan(125)
  })

  it('returns null for unusable input', () => {
    expect(distanceMeters({ lat: null, lng: null }, { lat: 1, lng: 1 })).toBeNull()
    expect(distanceMeters(null, { lat: 1, lng: 1 })).toBeNull()
  })
})

describe('formatDistance', () => {
  it('formats metres and kilometres', () => {
    expect(formatDistance(350)).toBe('350 m')
    expect(formatDistance(1200)).toBe('1.2 km')
    expect(formatDistance(Number.NaN)).toBe('')
  })
})

describe('circlePolygon', () => {
  it('returns a closed ring around the centre', () => {
    const ring = circlePolygon(4.5226, 8.4799, 50)
    expect(ring.length).toBe(65) // steps + 1 closing point
    expect(ring[0]).toEqual(ring[ring.length - 1])
  })

  it('spans approximately the requested radius in latitude', () => {
    const ring = circlePolygon(4.5226, 8.4799, 100)
    const lats = ring.map(([, lat]) => lat)
    const spanM = (Math.max(...lats) - Math.min(...lats)) * 111320
    expect(spanM).toBeGreaterThan(190)
    expect(spanM).toBeLessThan(210)
  })
})

describe('nearestSnap (bottom sheet)', () => {
  // Visibility order: 0 = peek (translateY 700), 1 = mid (350), 2 = full (0).
  const snaps = [700, 350, 0]

  it('snaps to the nearest position', () => {
    expect(nearestSnap(650, snaps)).toBe(0)
    expect(nearestSnap(300, snaps)).toBe(1)
    expect(nearestSnap(40, snaps)).toBe(2)
  })

  it('a downward flick (positive velocity) moves towards peek', () => {
    expect(nearestSnap(330, snaps, 1.2)).toBe(0)
  })

  it('an upward flick (negative velocity) moves towards full', () => {
    expect(nearestSnap(370, snaps, -1.2)).toBe(2)
  })

  it('clamps at the extremes', () => {
    expect(nearestSnap(0, snaps, -2)).toBe(2)
    expect(nearestSnap(700, snaps, 2)).toBe(0)
  })

  it('handles a single snap and empty input', () => {
    expect(nearestSnap(10, [0])).toBe(0)
    expect(nearestSnap(10, [])).toBe(0)
  })
})
