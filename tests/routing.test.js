import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROUTING_BASE,
  REROUTE_MIN_MOVE_M,
  ROUTE_FALLBACK_NOTE,
  buildRouteUrl,
  fetchRoute,
  formatDuration,
  formatRouteDistance,
  parseRouteResponse,
  routingBase,
  shouldReroute,
} from '../src/lib/routing'

const PICKUP = { lat: 8.4799, lng: 4.5226 }
const DEST = { lat: 8.4825, lng: 4.5261 }

describe('routingBase', () => {
  it('falls back to the public OSRM demo server', () => {
    expect(routingBase(undefined)).toBe(DEFAULT_ROUTING_BASE)
    expect(routingBase('')).toBe(DEFAULT_ROUTING_BASE)
    expect(routingBase('   ')).toBe(DEFAULT_ROUTING_BASE)
  })

  it('uses a configured provider origin and strips trailing slashes', () => {
    expect(routingBase('https://router.example.com')).toBe('https://router.example.com')
    expect(routingBase('https://router.example.com/')).toBe('https://router.example.com')
  })
})

describe('buildRouteUrl', () => {
  it('builds an OSRM driving URL with lng,lat ordering', () => {
    const url = buildRouteUrl(PICKUP, DEST, 'https://router.test')
    expect(url).toBe(
      'https://router.test/route/v1/driving/4.522600,8.479900;4.526100,8.482500' +
        '?overview=full&geometries=geojson',
    )
  })

  it('returns null when either endpoint is unusable', () => {
    expect(buildRouteUrl(null, DEST)).toBeNull()
    expect(buildRouteUrl(PICKUP, { lat: null, lng: null })).toBeNull()
    expect(buildRouteUrl({ lat: 0, lng: 0 }, DEST)).toBeNull()
  })
})

describe('parseRouteResponse', () => {
  const osrmPayload = {
    routes: [
      {
        duration: 132.7,
        distance: 612.4,
        geometry: {
          type: 'LineString',
          coordinates: [
            [4.5226, 8.4799],
            [4.524, 8.481],
            [4.5261, 8.4825],
          ],
        },
      },
    ],
  }

  it('parses coordinates, duration and distance', () => {
    const route = parseRouteResponse(osrmPayload)
    expect(route.coordinates).toHaveLength(3)
    expect(route.coordinates[0]).toEqual([4.5226, 8.4799])
    expect(route.seconds).toBe(133)
    expect(route.meters).toBe(612)
  })

  it('returns null for "no route" responses', () => {
    expect(parseRouteResponse({ routes: [] })).toBeNull()
    expect(parseRouteResponse({})).toBeNull()
    expect(parseRouteResponse(null)).toBeNull()
  })

  it('returns null for malformed geometry', () => {
    expect(
      parseRouteResponse({ routes: [{ geometry: { coordinates: [[4.1]] } }] }),
    ).toBeNull()
    expect(
      parseRouteResponse({
        routes: [{ geometry: { coordinates: [['x', 'y'], ['a', 'b']] } }],
      }),
    ).toBeNull()
  })

  it('keeps seconds/meters null when the provider omits them', () => {
    const route = parseRouteResponse({
      routes: [{ geometry: osrmPayload.routes[0].geometry }],
    })
    expect(route.seconds).toBeNull()
    expect(route.meters).toBeNull()
  })
})

describe('fetchRoute', () => {
  it('parses a successful provider response', async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({
        routes: [
          {
            duration: 60,
            distance: 300,
            geometry: {
              coordinates: [
                [4.52, 8.47],
                [4.53, 8.48],
              ],
            },
          },
        ],
      }),
    })
    const route = await fetchRoute(PICKUP, DEST, { fetchImpl })
    expect(route).not.toBeNull()
    expect(route.seconds).toBe(60)
    expect(route.meters).toBe(300)
  })

  it('returns null (never throws) on HTTP failure', async () => {
    const fetchImpl = async () => ({ ok: false, json: async () => ({}) })
    expect(await fetchRoute(PICKUP, DEST, { fetchImpl })).toBeNull()
  })

  it('returns null on a network error', async () => {
    const fetchImpl = async () => {
      throw new Error('offline')
    }
    expect(await fetchRoute(PICKUP, DEST, { fetchImpl })).toBeNull()
  })

  it('does not touch the network for unusable coordinates', async () => {
    let called = false
    const fetchImpl = async () => {
      called = true
      return { ok: true, json: async () => ({}) }
    }
    expect(await fetchRoute(null, DEST, { fetchImpl })).toBeNull()
    expect(called).toBe(false)
  })
})

describe('shouldReroute', () => {
  it('routes the first time (no previous origin)', () => {
    expect(shouldReroute(PICKUP, null)).toBe(true)
  })

  it('skips micro-moves below the re-route threshold', () => {
    const jitter = { lat: 8.47992, lng: 4.52262 } // ~3 m
    expect(shouldReroute(jitter, PICKUP)).toBe(false)
    expect(REROUTE_MIN_MOVE_M).toBeGreaterThanOrEqual(30)
  })

  it('re-routes after a real move', () => {
    const moved = { lat: 8.4805, lng: 4.5232 } // ~70 m
    expect(shouldReroute(moved, PICKUP)).toBe(true)
  })

  it('never routes from an unusable live position', () => {
    expect(shouldReroute(null, PICKUP)).toBe(false)
  })
})

describe('labels', () => {
  it('formatDuration is honest and never says 0 min', () => {
    expect(formatDuration(0)).toBe('')
    expect(formatDuration(Number.NaN)).toBe('')
    expect(formatDuration(45)).toBe('1 min')
    expect(formatDuration(120)).toBe('2 min')
    expect(formatDuration(3600)).toBe('1 hr')
    expect(formatDuration(3660)).toBe('1 hr 1 min')
  })

  it('formatRouteDistance uses m below a kilometre', () => {
    expect(formatRouteDistance(500)).toBe('500 m')
    expect(formatRouteDistance(1500)).toBe('1.5 km')
    expect(formatRouteDistance(Number.NaN)).toBe('')
  })

  it('ROUTE_FALLBACK_NOTE admits the line is not a road route', () => {
    expect(ROUTE_FALLBACK_NOTE).toMatch(/not a road route/i)
  })
})
