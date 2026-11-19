// Live GPS tracking logic (spec sections 6–8): fix validation, publish
// throttling, freshness classification, arrival proximity, ride eligibility.
//
// Pure functions only — the actual watchPosition loop lives in
// lib/useRideTracking.js; these rules are unit-tested in tests/tracking.test.js.
//
// Honesty rules encoded here:
//   * a fix with an absurd accuracy circle is DROPPED, not published;
//   * freshness labels are computed from the server-stamped updated_at;
//   * "nearby" is proximity, never a ride-state change (states move only
//     through the existing authorised server-side functions).

import { distanceMeters, validCoord } from './geo.js'

// Ride statuses during which the assigned rider's device publishes GPS.
export const TRACKABLE_STATUSES = ['accepted', 'paid', 'arrived', 'on_trip']

function envNumber(key) {
  try {
    const raw = Number(import.meta?.env?.[key])
    return Number.isFinite(raw) && raw > 0 ? raw : null
  } catch {
    return null
  }
}

// Thresholds (metres / ms) — env-overridable, documented in .env.example.
export function trackingConfig() {
  return {
    // A fix less accurate than this is too noisy to show as "the keke".
    maxAccuracyM: envNumber('VITE_TRACK_MAX_ACCURACY_M') ?? 100,
    // Within this road-distance of the pick-up we call the keke "nearby"
    // (approximate; the authoritative 'arrived' state still comes from the
    // rider marking arrival through the existing function).
    arrivalRadiusM: envNumber('VITE_ARRIVAL_RADIUS_M') ?? 40,
    // Within this straight-line distance the keke counts as "approaching"
    // the student's pick-up (honest label, not an ETA).
    approachRadiusM: envNumber('VITE_APPROACH_RADIUS_M') ?? 400,
    // Publish pacing: at most one write per interval, never for tiny jitter,
    // but always refresh at least this often so freshness never looks dead.
    // Task 6 (2026-11): tightened from 4 s / 15 s so a riding keke publishes
    // every ~2.5 s while moving and never goes longer than 6 s between
    // writes — inside the 2–5 s target for student map updates.
    // (tests/tracking.test.js pins minIntervalMs > 2000 and heartbeatMs > 5000.)
    minIntervalMs: 2500,
    minDistanceM: 5,
    heartbeatMs: 6000,
    // If the device watch has delivered NO fix for this long while rides are
    // active, the hook re-arms it (stop + start watchPosition) so a quietly
    // dead watch cannot leave the student staring at a frozen keke. Must sit
    // well above heartbeatMs so a healthy watch is never restarted.
    rearmAfterMs: 15000,
    // Freshness buckets for the student's "updated Xs ago" label. Live is
    // now 20 s (was 45 s): with a 6 s publish heartbeat, anything older
    // than 20 s genuinely is not live any more — the label stays honest.
    // (tests pin: 10 s must be live, 60 s must be stale, 300 s must be lost.)
    liveAfterMs: 20000,
    staleAfterMs: 120000,
  }
}

// Normalise a browser GeolocationCoordinates (+ timestamp) into a publishable
// fix, or null when the reading is unusable.
//   input:  { latitude, longitude, accuracy, heading, speed, timestamp }
//   output: { lat, lng, accuracy, heading, speed, timestamp } | null
export function normalizeFix(coords, { maxAccuracyM = trackingConfig().maxAccuracyM } = {}) {
  if (!coords) return null

  const lat = Number(coords.latitude ?? coords.lat)
  const lng = Number(coords.longitude ?? coords.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  if (lat === 0 && lng === 0) return null

  const accuracy = Number.isFinite(Number(coords.accuracy)) && Number(coords.accuracy) >= 0
    ? Number(coords.accuracy)
    : null
  // Drop extremely inaccurate readings (GPS off / indoor / spoofed).
  if (accuracy !== null && accuracy > maxAccuracyM) return null

  const heading = Number.isFinite(Number(coords.heading)) && Number(coords.heading) >= 0
    && Number(coords.heading) <= 360 ? Number(coords.heading) : null
  const speed = Number.isFinite(Number(coords.speed)) && Number(coords.speed) >= 0
    ? Number(coords.speed) : null

  return {
    lat,
    lng,
    accuracy,
    heading,
    speed,
    timestamp: Number.isFinite(Number(coords.timestamp)) ? Number(coords.timestamp) : Date.now(),
  }
}

// Publish pacing: first fix always goes out; afterwards require minInterval
// AND a real move — except a heartbeat every heartbeatMs so a stationary
// rider still refreshes updated_at (freshness must not look stale).
export function shouldPublishFix({ previous, previousAt, fix, now = Date.now(), config = trackingConfig() }) {
  if (!fix) return false
  if (!previous || !Number.isFinite(previousAt)) return true

  const elapsed = now - previousAt
  if (elapsed < config.minIntervalMs) return false
  if (elapsed >= config.heartbeatMs) return true

  const moved = distanceMeters(previous, fix)
  if (moved === null) return true
  return moved >= config.minDistanceM
}

// Freshness of the latest position, from the SERVER-stamped updated_at.
//   state: 'live'  — within liveAfterMs  (green "live" badge)
//          'stale' — past liveAfterMs    (amber "updating slowly")
//          'lost'  — past staleAfterMs   (grey "location delayed")
export function positionFreshness(updatedAt, { now = Date.now(), config = trackingConfig() } = {}) {
  const at = new Date(updatedAt ?? 0).getTime()
  if (!Number.isFinite(at) || at <= 0) {
    return { state: 'lost', ageMs: null, label: 'No location yet' }
  }
  const ageMs = Math.max(0, now - at)
  const state = ageMs <= config.liveAfterMs ? 'live'
    : ageMs <= config.staleAfterMs ? 'stale'
      : 'lost'
  return { state, ageMs, label: ageLabel(ageMs) }
}

function ageLabel(ageMs) {
  const seconds = Math.floor(ageMs / 1000)
  if (seconds < 60) return `updated ${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `last update ${minutes} min ago`
  return `last update ${Math.floor(minutes / 60)} hr ago`
}

// "Nearby" proximity phase for arrival UI. Distance is straight-line from
// the LIVE position to the pick-up; `fresh` gates it so a stale coordinate
// can never trigger a false arrival banner.
export function nearbyArrival({ distance, fresh, radiusM = trackingConfig().arrivalRadiusM }) {
  if (!fresh) return false
  if (!Number.isFinite(distance)) return false
  return distance <= radiusM
}

// Proximity phase for the student's "how close is my keke" UI.
//   'unavailable' — no usable distance, OR the position is not live: a
//                   stale/lost fix can never claim a proximity;
//   'far'         — beyond approachRadiusM from the target;
//   'approaching' — within approachRadiusM;
//   'nearby'      — within arrivalRadiusM (same radius as nearbyArrival).
export function proximityState({
  distance,
  fresh = false,
  radiusM = trackingConfig().arrivalRadiusM,
  approachM = trackingConfig().approachRadiusM,
} = {}) {
  if (!fresh) return 'unavailable'
  if (!Number.isFinite(distance) || distance < 0) return 'unavailable'
  if (distance <= radiusM) return 'nearby'
  if (distance <= approachM) return 'approaching'
  return 'far'
}

// Which of this rider's rides should be publishing GPS right now?
export function trackableRideIds(rides) {
  if (!Array.isArray(rides)) return []
  return rides
    .filter((r) => r && TRACKABLE_STATUSES.includes(r.status) && r.id)
    .map((r) => r.id)
}

// Should the student's keke-origin route be recomputed for this phase?
export function routePhaseFor(status, hasKekePos) {
  if (['accepted', 'paid', 'arrived'].includes(status)) return hasKekePos ? 'keke_to_pickup' : 'pending'
  if (status === 'on_trip') return 'trip'
  if (status === 'searching') return 'planned'
  return null
}

// Display state for a keke badge on the campus map (spec §3) — computed
// ONLY from the rider's own online flag and the SERVER-stamped heartbeat,
// never from the position itself:
//   'live'        — heartbeat within liveAfterMs: safe to claim "Live";
//   'stale'       — heartbeat seen but aging: "Updating slowly", never "live";
//   'unavailable' — no heartbeat at all, or lost past staleAfterMs;
//   'offline'     — the rider has gone offline (no GPS is being published).
export function kekeMarkerState({
  status,
  last_seen,
  now = Date.now(),
  config = trackingConfig(),
} = {}) {
  if (String(status ?? '').trim().toLowerCase() === 'offline') return 'offline'
  if (!last_seen) return 'unavailable'
  const { state } = positionFreshness(last_seen, { now, config })
  if (state === 'live') return 'live'
  if (state === 'stale') return 'stale'
  return 'unavailable'
}

// Popup / badge wording per state — plain words, no colour-only signals.
export const KEKE_STATE_LABELS = {
  live: 'Live',
  stale: 'Updating slowly',
  unavailable: 'Location delayed',
  offline: 'Offline',
}

// ---------------------------------------------------------------------------
// Arrival ETA (distance-based countdown for the student's ride screen)
// ---------------------------------------------------------------------------

// Campus roads are not straight lines: the real path is this much longer
// than the crow-flies distance (empirically ~25–40% on a campus loop).
export const ETA_DETOUR_FACTOR = 1.3
// Assumed keke pace when the GPS fix carries no usable speed: 4.5 m/s
// ≈ 16 km/h — a campus keke's realistic door-to-door average.
export const ETA_DEFAULT_SPEED_MPS = 4.5
// Reported speeds outside this band (m/s) are GPS noise, not truth.
export const ETA_MIN_SPEED_MPS = 1.5
export const ETA_MAX_SPEED_MPS = 20

// Honest arrival estimate from a REAL distance. Never invents an ETA:
// returns null without a usable distance, and only ever scales the
// measured distance by the detour factor / speed below. The road ETA
// from the routing provider (when it answers) is preferred by callers;
// this is the fallback that keeps a countdown on screen when it does not.
export function estimateArrivalSeconds({
  distanceMeters: meters,
  speedMps,
  detourFactor = ETA_DETOUR_FACTOR,
  defaultSpeedMps = ETA_DEFAULT_SPEED_MPS,
} = {}) {
  if (!Number.isFinite(meters) || meters < 0) return null
  const speed =
    Number.isFinite(speedMps) &&
    speedMps >= ETA_MIN_SPEED_MPS &&
    speedMps <= ETA_MAX_SPEED_MPS
      ? speedMps
      : defaultSpeedMps
  if (!Number.isFinite(detourFactor) || detourFactor <= 0) return null
  if (!Number.isFinite(speed) || speed <= 0) return null
  return Math.max(0, Math.round((meters * detourFactor) / speed))
}

// Watchdog predicate for the GPS watch: has it been silent too long?
// `lastFixAt` = when the watch last delivered a usable fix; `startedAt`
// = when the watch was last (re-)armed. The LATER of the two is the
// baseline, so a re-arm itself grants a full rearmAfterMs window and the
// hook can never tight-loop restarts while the GPS is simply dead.
export function shouldRearmWatch({
  lastFixAt,
  startedAt,
  now = Date.now(),
  config = trackingConfig(),
} = {}) {
  const baselines = [lastFixAt, startedAt].filter(
    (t) => Number.isFinite(t) && t > 0,
  )
  if (baselines.length === 0) return true
  const baseline = Math.max(...baselines)
  return now - baseline >= config.rearmAfterMs
}
