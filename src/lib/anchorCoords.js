// Reference-pin coordinates for campus location names.
//
// `public/maps/veritas-campus-reference-anchors.geojson` holds campus pins
// the project owner supplied earlier — docs/campus-map-digitization.md:
// "reference pins only and do not overwrite the Supabase locations table".
// Some rows in `locations` still carry lat/lng = null (14 of 34 live), which
// would make any distance to the pick-up impossible to measure — so as a
// LAST resort the student ride screen resolves a location NAME against
// these pins:
//
//   1. the student's own position (best — "from you");
//   2. the location row's own coordinates;
//   3. a UNIQUE name match against the reference pins (this module).
//
// Nothing here writes to the database and nothing here invents coordinates:
// only real, previously supplied pins, matched conservatively (exact name,
// or a substring in EITHER direction that points at exactly one pin). An
// ambiguous or unknown name resolves to null and the UI shows no distance
// — never a guessed one.

import { useEffect, useState } from 'react'
import { validCoord } from './geo.js'

export const ANCHORS_URL = '/maps/veritas-campus-reference-anchors.geojson'

// GeoJSON point features → Map<name, {lat, lng}> (coordinates are [lng, lat]).
// First pin wins on duplicate names; unusable pins are skipped.
export function buildAnchorMap(geojson) {
  const map = new Map()
  for (const feature of geojson?.features ?? []) {
    const name = String(feature?.properties?.name ?? '').trim()
    const coords = feature?.geometry?.coordinates
    if (!name || !Array.isArray(coords)) continue
    const point = { lat: Number(coords[1]), lng: Number(coords[0]) }
    if (!validCoord(point) || map.has(name)) continue
    map.set(name, point)
  }
  return map
}

// Conservative name → pin resolution:
//   * exact match (case-insensitive) wins immediately;
//   * otherwise a substring match in EITHER direction, but ONLY when it
//     points at exactly one pin ("Front of MPH" → the "MPH" pin);
//   * two or more candidate pins → null (ambiguous: "Chapel Junction"
//     matches both "Chapel" and "Law/Chapel Junction" → no pin at all).
export function matchAnchor(locationName, anchors) {
  if (!(anchors instanceof Map) || anchors.size === 0) return null
  const name = String(locationName ?? '').trim().toLowerCase()
  if (!name) return null

  for (const [pinName, point] of anchors) {
    if (pinName.toLowerCase() === name) return point
  }

  let found = null
  for (const [pinName, point] of anchors) {
    const pin = pinName.toLowerCase()
    if (pin.length < 3) continue // tiny pins never substring-match
    if (pin.includes(name) || name.includes(pin)) {
      if (found && found !== point) return null // ambiguous → honest null
      found = point
    }
  }
  return found
}

// One fetch per app life; failures cache an EMPTY map (never a refetch
// loop, never a crash — the ride screen simply has no pin fallback).
// `resetAnchorsCache` mirrors campusRouting's resetCampusGraphCache and
// exists for the same reason: tests must be able to start from empty.
let cache = null
let pending = null

export function resetAnchorsCache() {
  cache = null
  pending = null
}

export function loadAnchors(fetchImpl) {
  if (cache) return Promise.resolve(cache)
  if (pending) return pending
  const doFetch = fetchImpl ?? (typeof fetch === 'function' ? fetch : null)
  if (!doFetch) {
    cache = new Map()
    return Promise.resolve(cache)
  }
  pending = doFetch(ANCHORS_URL)
    .then((res) => (res && res.ok ? res.json() : null))
    .then((json) => {
      cache = buildAnchorMap(json)
      return cache
    })
    .catch(() => {
      cache = new Map()
      return cache
    })
  return pending
}

// React accessor: re-renders once when the pins finish loading; returns the
// Map (or null before the first load resolves). Safe to mount repeatedly —
// the module cache makes later mounts synchronous.
export function useAnchors() {
  const [map, setMap] = useState(cache)
  useEffect(() => {
    let alive = true
    loadAnchors().then((m) => {
      if (alive) setMap(m)
    })
    return () => {
      alive = false
    }
  }, [])
  return map
}
