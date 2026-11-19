import { describe, expect, it } from 'vitest'
import {
  ETA_DETOUR_FACTOR,
  ETA_DEFAULT_SPEED_MPS,
  ETA_MAX_SPEED_MPS,
  ETA_MIN_SPEED_MPS,
  KEKE_STATE_LABELS,
  TRACKABLE_STATUSES,
  estimateArrivalSeconds,
  kekeMarkerState,
  nearbyArrival,
  normalizeFix,
  positionFreshness,
  proximityState,
  routePhaseFor,
  shouldPublishFix,
  shouldRearmWatch,
  trackableRideIds,
  trackingConfig,
} from '../src/lib/tracking'

const CONFIG = trackingConfig()

function fix(overrides = {}) {
  return {
    latitude: 8.4799,
    longitude: 4.5226,
    accuracy: 12,
    heading: 90,
    speed: 4.5,
    timestamp: 1_700_000_000_000,
    ...overrides,
  }
}

describe('normalizeFix', () => {
  it('accepts a real fix', () => {
    const out = normalizeFix(fix())
    expect(out).toMatchObject({ lat: 8.4799, lng: 4.5226, accuracy: 12, heading: 90, speed: 4.5 })
    expect(out.timestamp).toBe(1_700_000_000_000)
  })

  it('rejects missing / non-numeric coordinates', () => {
    expect(normalizeFix(null)).toBeNull()
    expect(normalizeFix({ latitude: 'x', longitude: 'y' })).toBeNull()
    expect(normalizeFix({ accuracy: 10 })).toBeNull()
  })

  it('rejects out-of-range coordinates and the 0,0 placeholder', () => {
    expect(normalizeFix(fix({ latitude: 95 }))).toBeNull()
    expect(normalizeFix(fix({ longitude: -181 }))).toBeNull()
    expect(normalizeFix(fix({ latitude: 0, longitude: 0 }))).toBeNull()
  })

  it('drops extremely inaccurate readings instead of publishing them', () => {
    expect(normalizeFix(fix({ accuracy: 5000 }))).toBeNull()
    expect(normalizeFix(fix({ accuracy: 99999 }))).toBeNull()
    // A fix without an accuracy value is kept — nothing proves it is bad.
    expect(normalizeFix(fix({ accuracy: undefined }))).not.toBeNull()
    expect(normalizeFix(fix({ accuracy: 30 }))).not.toBeNull()
  })

  it('normalises absurd heading/speed to null (not junk)', () => {
    expect(normalizeFix(fix({ heading: 720 })).heading).toBeNull()
    expect(normalizeFix(fix({ heading: -1 })).heading).toBeNull()
    expect(normalizeFix(fix({ speed: -3 })).speed).toBeNull()
  })

  it('honours a stricter configured accuracy threshold', () => {
    expect(normalizeFix(fix({ accuracy: 60 }), { maxAccuracyM: 50 })).toBeNull()
    expect(normalizeFix(fix({ accuracy: 40 }), { maxAccuracyM: 50 })).not.toBeNull()
  })
})

describe('shouldPublishFix', () => {
  const t0 = 1_700_000_000_000

  it('always publishes the first fix', () => {
    expect(
      shouldPublishFix({ previous: null, previousAt: null, fix: { lat: 1, lng: 2 }, now: t0 }),
    ).toBe(true)
  })

  it('throttles within the minimum interval', () => {
    expect(
      shouldPublishFix({
        previous: { lat: 8.4799, lng: 4.5226 },
        previousAt: t0,
        fix: { lat: 8.4805, lng: 4.5232 },
        now: t0 + 2000, // 2s < 4s
        config: CONFIG,
      }),
    ).toBe(false)
  })

  it('publishes after the interval only for a real move', () => {
    const base = {
      previous: { lat: 8.4799, lng: 4.5226 },
      previousAt: t0,
      now: t0 + 5000,
      config: CONFIG,
    }
    expect(
      shouldPublishFix({ ...base, fix: { lat: 8.47991, lng: 4.52261 } }), // ~1 m
    ).toBe(false)
    expect(
      shouldPublishFix({ ...base, fix: { lat: 8.4805, lng: 4.5232 } }), // ~70 m
    ).toBe(true)
  })

  it('heartbeats anyway so a stationary rider never looks stale', () => {
    expect(
      shouldPublishFix({
        previous: { lat: 8.4799, lng: 4.5226 },
        previousAt: t0,
        fix: { lat: 8.4799, lng: 4.5226 },
        now: t0 + CONFIG.heartbeatMs,
        config: CONFIG,
      }),
    ).toBe(true)
  })
})

describe('positionFreshness', () => {
  const now = 1_700_000_000_000

  it('reports "no location" for a missing timestamp', () => {
    const out = positionFreshness(null, { now })
    expect(out.state).toBe('lost')
    expect(out.label).toBe('No location yet')
  })

  it('classifies live / stale / lost from the server timestamp', () => {
    expect(positionFreshness(now - 10_000, { now }).state).toBe('live')
    expect(positionFreshness(now - 60_000, { now }).state).toBe('stale')
    expect(positionFreshness(now - 300_000, { now }).state).toBe('lost')
  })

  it('labels the age honestly', () => {
    expect(positionFreshness(now - 12_000, { now }).label).toBe('updated 12s ago')
    expect(positionFreshness(now - 60_000, { now }).label).toBe('last update 1 min ago')
    expect(positionFreshness(now - 300_000, { now }).label).toBe('last update 5 min ago')
  })
})

describe('nearbyArrival', () => {
  it('fires inside the radius from a fresh fix', () => {
    expect(nearbyArrival({ distance: 25, fresh: true })).toBe(true)
  })

  it('never fires from stale data (no false arrivals)', () => {
    expect(nearbyArrival({ distance: 25, fresh: false })).toBe(false)
  })

  it('stays quiet outside the radius or without a distance', () => {
    expect(nearbyArrival({ distance: 500, fresh: true })).toBe(false)
    expect(nearbyArrival({ distance: null, fresh: true })).toBe(false)
    expect(nearbyArrival({ distance: Number.NaN, fresh: true })).toBe(false)
  })

  it('respects a configured radius', () => {
    expect(nearbyArrival({ distance: 60, fresh: true, radiusM: 40 })).toBe(false)
    expect(nearbyArrival({ distance: 60, fresh: true, radiusM: 80 })).toBe(true)
  })
})

describe('proximityState', () => {
  it('reports nearby inside the arrival radius', () => {
    expect(proximityState({ distance: 25, fresh: true })).toBe('nearby')
    expect(proximityState({ distance: 40, fresh: true })).toBe('nearby')
  })

  it('reports approaching between the arrival and approach radii', () => {
    expect(proximityState({ distance: 41, fresh: true })).toBe('approaching')
    expect(proximityState({ distance: 400, fresh: true })).toBe('approaching')
  })

  it('reports far beyond the approach radius', () => {
    expect(proximityState({ distance: 401, fresh: true })).toBe('far')
    expect(proximityState({ distance: 5000, fresh: true })).toBe('far')
  })

  it('never claims a proximity from a stale or lost fix', () => {
    expect(proximityState({ distance: 25, fresh: false })).toBe('unavailable')
    expect(proximityState({ distance: 41, fresh: false })).toBe('unavailable')
  })

  it('is unavailable without a usable distance', () => {
    expect(proximityState({ distance: null, fresh: true })).toBe('unavailable')
    expect(proximityState({ distance: Number.NaN, fresh: true })).toBe('unavailable')
    expect(proximityState({ distance: -5, fresh: true })).toBe('unavailable')
    expect(proximityState({})).toBe('unavailable')
  })

  it('honours configured radii', () => {
    expect(proximityState({ distance: 60, fresh: true, radiusM: 80 })).toBe('nearby')
    expect(
      proximityState({ distance: 45, fresh: true, radiusM: 40, approachM: 50 }),
    ).toBe('approaching')
    expect(
      proximityState({ distance: 60, fresh: true, radiusM: 40, approachM: 50 }),
    ).toBe('far')
  })
})

describe('kekeMarkerState', () => {
  const now = 1_700_000_000_000

  it('calls a fresh heartbeat live', () => {
    expect(kekeMarkerState({ status: 'online', last_seen: now - 10_000, now })).toBe('live')
  })

  it('never calls an aging heartbeat live', () => {
    expect(kekeMarkerState({ status: 'online', last_seen: now - 60_000, now })).toBe('stale')
    expect(kekeMarkerState({ status: 'online', last_seen: now - 300_000, now })).toBe('unavailable')
  })

  it('marks riders that went offline as offline', () => {
    // Even with a recent heartbeat — the rider stopped publishing on purpose.
    expect(kekeMarkerState({ status: 'offline', last_seen: now - 5_000, now })).toBe('offline')
    expect(kekeMarkerState({ status: 'OFFLINE', last_seen: null, now })).toBe('offline')
  })

  it('is unavailable without any heartbeat', () => {
    expect(kekeMarkerState({ status: 'online', last_seen: null, now })).toBe('unavailable')
    expect(kekeMarkerState({ status: 'online', last_seen: undefined, now })).toBe('unavailable')
    expect(kekeMarkerState({ now })).toBe('unavailable')
  })

  it('exposes plain-word labels for every state', () => {
    expect(KEKE_STATE_LABELS.live).toBe('Live')
    expect(KEKE_STATE_LABELS.stale).toBe('Updating slowly')
    expect(KEKE_STATE_LABELS.unavailable).toBe('Location delayed')
    expect(KEKE_STATE_LABELS.offline).toBe('Offline')
  })
})

describe('trackableRideIds', () => {
  it('includes only rides in a GPS-sharing status', () => {
    const rides = [
      { id: 'a', status: 'accepted' },
      { id: 'b', status: 'paid' },
      { id: 'c', status: 'arrived' },
      { id: 'd', status: 'on_trip' },
      { id: 'e', status: 'searching' },
      { id: 'f', status: 'completed' },
      { id: 'g', status: 'cancelled' },
    ]
    expect(trackableRideIds(rides)).toEqual(['a', 'b', 'c', 'd'])
    expect(TRACKABLE_STATUSES).toEqual(['accepted', 'paid', 'arrived', 'on_trip'])
  })

  it('is defensive about bad input', () => {
    expect(trackableRideIds(null)).toEqual([])
    expect(trackableRideIds([{ status: 'paid' }])).toEqual([]) // no id
  })
})

describe('routePhaseFor', () => {
  it('routes keke → pick-up while the rider heads over', () => {
    expect(routePhaseFor('accepted', true)).toBe('keke_to_pickup')
    expect(routePhaseFor('paid', true)).toBe('keke_to_pickup')
    expect(routePhaseFor('arrived', true)).toBe('keke_to_pickup')
  })

  it('waits for a position before claiming a keke leg', () => {
    expect(routePhaseFor('accepted', false)).toBe('pending')
  })

  it('routes pick-up → destination once on trip / while planning', () => {
    expect(routePhaseFor('on_trip', true)).toBe('trip')
    expect(routePhaseFor('searching', false)).toBe('planned')
  })

  it('has no route phase for finished rides', () => {
    expect(routePhaseFor('completed', true)).toBeNull()
    expect(routePhaseFor('cancelled', true)).toBeNull()
  })
})

describe('estimateArrivalSeconds', () => {
  it('never invents an ETA without a real distance', () => {
    expect(estimateArrivalSeconds({})).toBeNull()
    expect(estimateArrivalSeconds({ distanceMeters: null })).toBeNull()
    expect(estimateArrivalSeconds({ distanceMeters: '500' })).toBeNull()
    expect(estimateArrivalSeconds({ distanceMeters: -10 })).toBeNull()
    expect(estimateArrivalSeconds({ distanceMeters: Number.NaN })).toBeNull()
  })

  it('scales the measured distance by detour factor ÷ default speed', () => {
    // 520 m × 1.3 = 676 m ÷ 4.5 m/s ≈ 150 s
    expect(estimateArrivalSeconds({ distanceMeters: 520 })).toBe(
      Math.round((520 * ETA_DETOUR_FACTOR) / ETA_DEFAULT_SPEED_MPS),
    )
    expect(estimateArrivalSeconds({ distanceMeters: 0 })).toBe(0)
  })

  it('counts DOWN as the distance shrinks and UP as it grows', () => {
    const far = estimateArrivalSeconds({ distanceMeters: 900 })
    const near = estimateArrivalSeconds({ distanceMeters: 300 })
    const gone = estimateArrivalSeconds({ distanceMeters: 1200 })
    expect(near).toBeLessThan(far)
    expect(gone).toBeGreaterThan(far)
  })

  it('uses a reported speed only inside the honest band', () => {
    expect(
      estimateArrivalSeconds({ distanceMeters: 450, speedMps: 9 }),
    ).toBe(Math.round((450 * ETA_DETOUR_FACTOR) / 9))
    // Below / above the band is GPS noise → falls back to default speed.
    expect(
      estimateArrivalSeconds({ distanceMeters: 450, speedMps: ETA_MIN_SPEED_MPS - 1 }),
    ).toBe(estimateArrivalSeconds({ distanceMeters: 450 }))
    expect(
      estimateArrivalSeconds({ distanceMeters: 450, speedMps: ETA_MAX_SPEED_MPS + 1 }),
    ).toBe(estimateArrivalSeconds({ distanceMeters: 450 }))
    expect(
      estimateArrivalSeconds({ distanceMeters: 450, speedMps: -3 }),
    ).toBe(estimateArrivalSeconds({ distanceMeters: 450 }))
  })
})

describe('shouldRearmWatch', () => {
  const T = 1_700_000_000_000

  it('re-arms a watch that has delivered no fix at all', () => {
    expect(shouldRearmWatch({ lastFixAt: 0, startedAt: 0, now: T + 1 })).toBe(true)
  })

  it('waits a full rearm window after a real fix', () => {
    expect(
      shouldRearmWatch({ lastFixAt: T, startedAt: T, now: T + CONFIG.rearmAfterMs - 1 }),
    ).toBe(false)
    expect(
      shouldRearmWatch({ lastFixAt: T, startedAt: T, now: T + CONFIG.rearmAfterMs }),
    ).toBe(true)
  })

  it('a re-arm itself grants a full window (no tight restart loop)', () => {
    // Watch restarted 5 s ago but the old fix is ancient: baseline must be
    // the RESTART time, so a dead GPS costs one restart per window.
    expect(
      shouldRearmWatch({
        lastFixAt: T - 120_000,
        startedAt: T,
        now: T + 5_000,
      }),
    ).toBe(false)
    expect(
      shouldRearmWatch({
        lastFixAt: T - 120_000,
        startedAt: T,
        now: T + CONFIG.rearmAfterMs,
      }),
    ).toBe(true)
  })

  it('uses the LATER baseline, never the earlier one', () => {
    // Fix arrived after the restart (fresh) → keep watching.
    expect(
      shouldRearmWatch({ lastFixAt: T, startedAt: T - 60_000, now: T + 1_000 }),
    ).toBe(false)
  })
})
