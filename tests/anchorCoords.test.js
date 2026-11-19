import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAnchorMap,
  loadAnchors,
  matchAnchor,
  resetAnchorsCache,
} from '../src/lib/anchorCoords'

// Real shape of public/maps/veritas-campus-reference-anchors.geojson
// (a subset of the actual pins, kept inline so tests never hit the network).
function geojson(features) {
  return { type: 'FeatureCollection', features }
}

function pin(name, lng, lat) {
  return {
    type: 'Feature',
    properties: { name },
    geometry: { type: 'Point', coordinates: [lng, lat] },
  }
}

const ANCHORS = buildAnchorMap(
  geojson([
    pin('Main Gate', 7.416442, 9.296319),
    pin('MPH', 7.415811, 9.287756),
    pin('Chapel', 7.418431, 9.287972),
    pin('Law/Chapel Junction', 7.417567, 9.2883),
    pin('Hostel N', 7.410137, 9.287017),
  ]),
)

describe('buildAnchorMap', () => {
  it('maps GeoJSON [lng, lat] points to {lat, lng} by name', () => {
    expect(ANCHORS.get('Main Gate')).toEqual({ lat: 9.296319, lng: 7.416442 })
    expect(ANCHORS.get('MPH')).toEqual({ lat: 9.287756, lng: 7.415811 })
  })

  it('skips nameless / unusable features and keeps the first duplicate', () => {
    const map = buildAnchorMap(
      geojson([
        pin('A', 7.4, 9.2),
        pin('A', 7.5, 9.3), // duplicate — first wins
        { ...pin('', 7.4, 9.2), properties: { name: '  ' } },
        { ...pin('Bad', 'x', 9.2) },
        { type: 'Feature', properties: { name: 'NoGeom' } },
      ]),
    )
    expect(map.get('A')).toEqual({ lat: 9.2, lng: 7.4 })
    expect(map.size).toBe(1)
  })

  it('survives null / garbage input with an empty map', () => {
    expect(buildAnchorMap(null).size).toBe(0)
    expect(buildAnchorMap({}).size).toBe(0)
    expect(buildAnchorMap({ features: 'nope' }).size).toBe(0)
  })
})

describe('matchAnchor', () => {
  it('matches an exact name, case-insensitively', () => {
    expect(matchAnchor('Main Gate', ANCHORS)).toEqual({ lat: 9.296319, lng: 7.416442 })
    expect(matchAnchor('  main gate ', ANCHORS)).toEqual({ lat: 9.296319, lng: 7.416442 })
  })

  it('resolves "Front of MPH" to the unique "MPH" pin', () => {
    expect(matchAnchor('Front of MPH', ANCHORS)).toEqual({ lat: 9.287756, lng: 7.415811 })
  })

  it('resolves the other direction too ("MPH" vs an exact pin stays exact)', () => {
    expect(matchAnchor('MPH', ANCHORS)).toEqual({ lat: 9.287756, lng: 7.415811 })
  })

  it('refuses ambiguous names instead of guessing', () => {
    // "Chapel Junction" sits inside BOTH "Chapel" and "Law/Chapel Junction".
    expect(matchAnchor('Chapel Junction', ANCHORS)).toBeNull()
  })

  it('returns null for unknown names and empty input', () => {
    expect(matchAnchor('Nowhere Building', ANCHORS)).toBeNull()
    expect(matchAnchor('', ANCHORS)).toBeNull()
    expect(matchAnchor(null, ANCHORS)).toBeNull()
    expect(matchAnchor('Main Gate', null)).toBeNull()
    expect(matchAnchor('Main Gate', new Map())).toBeNull()
  })
})

describe('loadAnchors', () => {
  beforeEach(() => resetAnchorsCache())

  it('fetches once and reuses the cached map afterwards', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => geojson([pin('Solo', 7.41, 9.28)]),
    }))

    const first = await loadAnchors(fetchImpl)
    const second = await loadAnchors(fetchImpl)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(first.get('Solo')).toEqual({ lat: 9.28, lng: 7.41 })
  })

  it('caches an EMPTY map on failure — no retry loop, no crash', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    })

    const first = await loadAnchors(failing)
    const second = await loadAnchors(failing)

    expect(failing).toHaveBeenCalledTimes(1)
    expect(first.size).toBe(0)
    expect(second).toBe(first)
  })
})
