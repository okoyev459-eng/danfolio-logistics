// Road-routing provider layer (spec section 5).
//
// The provider must speak the OSRM HTTP API:
//   GET <base>/route/v1/driving/{lng},{lat};{lng},{lat}?overview=full&geometries=geojson
// where <base> is the routing SERVER ORIGIN (no path). That covers the
// public OSRM demo server (default, free, no key), a self-hosted OSRM
// instance, or any compatible proxy. Swap providers with VITE_ROUTING_URL —
// no code change.
//
// The demo server is rate-limited and best-effort: it is fine for
// development/testing, NOT a production SLA. See docs/map-and-live-tracking.md.
//
// Everything here is pure/async-pure so it can be unit-tested in tests/.

import { distanceMeters, validCoord } from './geo.js'

export const DEFAULT_ROUTING_BASE = 'https://router.project-osrm.org'

// Shown when the routing service cannot produce a road path. The map then
// draws a clearly-labelled direct line — never presented as a road route.
export const ROUTE_FALLBACK_NOTE =
  'Road route unavailable — showing a direct line, not a road route.'

// Re-request a route only when the live origin has moved at least this far
// (keeps the free OSRM demo server happy while GPS keeps ticking).
export const REROUTE_MIN_MOVE_M = 30

function env(key) {
  try {
    return import.meta?.env?.[key]
  } catch {
    return undefined
  }
}

// Configured routing server origin without a trailing slash (env override
// or default). No path: buildRouteUrl appends the standard OSRM route path.
export function routingBase(base = env('VITE_ROUTING_URL')) {
  const value = String(base ?? '').trim().replace(/\/+$/, '')
  return value || DEFAULT_ROUTING_BASE
}

// Build the request URL for one route. Returns null when either endpoint is
// not a usable coordinate (callers must not fire junk requests).
export function buildRouteUrl(from, to, base) {
  if (!validCoord(from) || !validCoord(to)) return null
  const origin = `${Number(from.lng).toFixed(6)},${Number(from.lat).toFixed(6)}`
  const dest = `${Number(to.lng).toFixed(6)},${Number(to.lat).toFixed(6)}`
  return `${routingBase(base)}/route/v1/driving/${origin};${dest}?overview=full&geometries=geojson`
}

// Parse an OSRM response into { coordinates, seconds, meters } or null.
// Handles: empty routes ("NoRoute"), malformed geometry, non-numeric values.
export function parseRouteResponse(data) {
  const route = data?.routes?.[0]
  const line = route?.geometry?.coordinates
  if (!Array.isArray(line) || line.length < 2) return null

  const coordinates = []
  for (const pair of line) {
    if (!Array.isArray(pair) || pair.length < 2) return null
    const lng = Number(pair[0])
    const lat = Number(pair[1])
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
    coordinates.push([lng, lat])
  }
  if (coordinates.length < 2) return null

  return {
    coordinates,
    seconds: Number.isFinite(route.duration) && route.duration >= 0
      ? Math.round(route.duration)
      : null,
    meters: Number.isFinite(route.distance) && route.distance >= 0
      ? Math.round(route.distance)
      : null,
  }
}

// Fetch + parse one route. Returns null on any failure (network, timeout,
// rate limit, no route) — callers decide how to degrade.
export async function fetchRoute(from, to, { base, timeoutMs = 6000, fetchImpl } = {}) {
  const url = buildRouteUrl(from, to, base)
  if (!url) return null

  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') return null

  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return null
    return parseRouteResponse(await res.json())
  } catch {
    return null
  }
}

// Should the route be recomputed for a new live origin? Keeps tiny GPS
// jitter (and per-second ticks) from hammering the routing service: only a
// real move past REROUTE_MIN_MOVE_M re-requests.
export function shouldReroute(currentOrigin, lastRoutedOrigin, minMeters = REROUTE_MIN_MOVE_M) {
  if (!validCoord(currentOrigin)) return false
  if (!validCoord(lastRoutedOrigin)) return true
  const moved = distanceMeters(lastRoutedOrigin, currentOrigin)
  if (moved === null) return true
  return moved >= minMeters
}

// Human duration: "4 min", "1 hr 5 min". Never returns "0 min" for a real
// route — the shortest honest label is "1 min".
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} hr ${rest} min` : `${hours} hr`
}

// Short distance label for route summaries (re-uses geo helpers' format).
export function formatRouteDistance(meters) {
  if (!Number.isFinite(meters) || meters <= 0) return ''
  if (meters < 1000) return `${meters} m`
  return `${(meters / 1000).toFixed(1)} km`
}
