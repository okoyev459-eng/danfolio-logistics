import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

import {
  CAMPUS_ROADS_URL,
  SNAP_MAX_M,
  buildCampusGraph,
  isRoutableRoad,
  loadCampusGraph,
  nodeKey,
  onewayDirection,
  resetCampusGraphCache,
  routeCampusTrip,
  routeOnGraph,
} from '../src/lib/campusRouting.js'
import { ROUTE_FALLBACK_NOTE } from '../src/lib/routing.js'

// Tests run against the REAL imported campus network (public/maps) so
// connectivity/snapping/routing claims are verified on the actual survey,
// plus small synthetic fixtures for one-way and pedestrian rules.

const mapsDir = path.resolve(process.cwd(), 'public/maps')
const readGeoJSON = (filename) => JSON.parse(
  fs.readFileSync(path.join(mapsDir, filename), 'utf8'),
)

const roads = readGeoJSON('veritas-campus-roads.geojson')
const anchors = readGeoJSON('veritas-campus-reference-anchors.geojson')

const anchorByName = Object.fromEntries(
  anchors.features.map((feature) => [
    feature.properties.name,
    { lng: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1] },
  ]),
)

// Admin-verified Main Gate coordinate (admin UI edit, DB-checked).
const MAIN_GATE = { lat: 9.296319, lng: 7.416442 }

const graph = buildCampusGraph(roads)

function lineFeature(coords, properties = {}) {
  return {
    type: 'Feature',
    properties: { highway: 'service', ...properties },
    geometry: { type: 'LineString', coordinates: coords },
  }
}

function fc(features) {
  return { type: 'FeatureCollection', features }
}

beforeEach(() => {
  resetCampusGraphCache()
})

describe('campus road graph (real imported network)', () => {
  it('builds a graph from shared road coordinates without inventing nodes', () => {
    expect(roads.features).toHaveLength(53)
    expect(graph.nodes.size).toBeGreaterThan(500)
    expect(graph.edges.length).toBeGreaterThan(500)

    // Every edge endpoint is a real node; every node carries its own
    // longitude/latitude (round-trip through the 7 dp key is lossless here).
    for (const edge of graph.edges) {
      expect(graph.nodes.has(edge.a)).toBe(true)
      expect(graph.nodes.has(edge.b)).toBe(true)
      expect(edge.a).not.toBe(edge.b)
      expect(edge.meters).toBeGreaterThan(0)
    }
    for (const [key, node] of graph.nodes) {
      expect(key).toBe(nodeKey(node.lng, node.lat))
    }
  })

  it('keeps the routable network fully connected (one component)', () => {
    // Weak connectivity: every node reachable from every other node when
    // direction is ignored — a route between any two snapped points exists.
    const undirected = new Map([...graph.nodes.keys()].map((k) => [k, []]))
    for (const edge of graph.edges) {
      undirected.get(edge.a).push(edge.b)
      undirected.get(edge.b).push(edge.a)
    }
    const start = graph.nodes.keys().next().value
    const seen = new Set([start])
    const stack = [start]
    while (stack.length) {
      const key = stack.pop()
      for (const next of undirected.get(key)) {
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    expect(seen.size).toBe(graph.nodes.size)
    expect(graph.adj.size).toBe(graph.nodes.size)
  })

  it('produces a road route between real campus locations', () => {
    const hostelK = anchorByName['Hostel K']
    const result = routeOnGraph(graph, hostelK, MAIN_GATE, { maxSnapM: SNAP_MAX_M })

    expect(result).not.toBeNull()
    expect(result.seconds).toBeNull() // distance only — never a fabricated ETA
    expect(result.meters).toBeGreaterThan(0)
    expect(result.coordinates.length).toBeGreaterThanOrEqual(2)

    // Road distance cannot be shorter than the straight line between the
    // snapped endpoints (and is realistically longer).
    const [first, last] = [result.coordinates[0], result.coordinates[result.coordinates.length - 1]]
    const straight = graphDistance(first, last)
    expect(result.meters).toBeGreaterThanOrEqual(straight - 5)

    // Every vertex stays inside the campus bounding box (lng/lat order).
    for (const [lng, lat] of result.coordinates) {
      expect(Number.isFinite(lng)).toBe(true)
      expect(Number.isFinite(lat)).toBe(true)
      expect(lng).toBeGreaterThan(7.40)
      expect(lng).toBeLessThan(7.43)
      expect(lat).toBeGreaterThan(9.27)
      expect(lat).toBeLessThan(9.31)
    }
  })

  it('routes from every reference anchor to the Main Gate', () => {
    for (const feature of anchors.features) {
      const point = {
        lng: feature.geometry.coordinates[0],
        lat: feature.geometry.coordinates[1],
      }
      const result = routeOnGraph(graph, point, MAIN_GATE, { maxSnapM: SNAP_MAX_M })
      expect(result, `route from ${feature.properties.name}`).not.toBeNull()
      expect(result.coordinates.length).toBeGreaterThanOrEqual(2)
      expect(result.meters).toBeGreaterThanOrEqual(0)
    }
  })

  it('snaps a nearby point onto a road and refuses points too far away', () => {
    const near = routeOnGraph(graph, anchorByName['Block A'], MAIN_GATE, { maxSnapM: SNAP_MAX_M })
    expect(near).not.toBeNull()

    // ~6 km off campus: no road within SNAP_MAX_M → honest null, not a line.
    const far = routeOnGraph(graph, { lat: 9.35, lng: 7.5 }, MAIN_GATE, { maxSnapM: SNAP_MAX_M })
    expect(far).toBeNull()

    // A tiny snap radius that no road satisfies also refuses.
    const tooStrict = routeOnGraph(graph, anchorByName['Hostel K'], MAIN_GATE, { maxSnapM: 0.001 })
    expect(tooStrict).toBeNull()
  })

  it('returns a valid two-point line when both endpoints are the same spot', () => {
    const result = routeOnGraph(graph, MAIN_GATE, MAIN_GATE, { maxSnapM: SNAP_MAX_M })
    expect(result).not.toBeNull()
    expect(result.coordinates).toHaveLength(2)
    expect(result.meters).toBe(0)
  })

  it('never mutates the cached graph while routing', () => {
    const before = { nodes: graph.nodes.size, edges: graph.edges.length }
    routeOnGraph(graph, anchorByName['Hostel K'], MAIN_GATE, { maxSnapM: SNAP_MAX_M })
    routeOnGraph(graph, anchorByName['Block A'], anchorByName['Block C'], { maxSnapM: SNAP_MAX_M })
    expect(graph.nodes.size).toBe(before.nodes)
    expect(graph.edges.length).toBe(before.edges)
  })
})

describe('one-way and access rules (synthetic fixtures)', () => {
  // Triangle: A→B is one-way (forward); B→C and C→A are two-way.
  const A = [7.41, 9.28]
  const B = [7.41, 9.29]
  const C = [7.42, 9.29]
  const triangle = fc([
    lineFeature([A, B], { oneway: 'yes' }),
    lineFeature([B, C]),
    lineFeature([C, A]),
  ])

  it('drives A→B directly but forces the long way round B→A', () => {
    const g = buildCampusGraph(triangle)
    const forward = routeOnGraph(g, { lng: A[0], lat: A[1] }, { lng: B[0], lat: B[1] })
    const reverse = routeOnGraph(g, { lng: B[0], lat: B[1] }, { lng: A[0], lat: A[1] })

    expect(forward).not.toBeNull()
    expect(reverse).not.toBeNull()
    // Direct ≈ 1.1 km; the legal way round ≈ 2.7 km — using the one-way
    // backwards would have made reverse SHORTER than forward.
    expect(forward.meters).toBeLessThan(1300)
    expect(reverse.meters).toBeGreaterThan(forward.meters * 1.8)
  })

  it('honours oneway=-1 (reverse only) and access bans', () => {
    expect(onewayDirection({ oneway: 'yes' })).toBe('forward')
    expect(onewayDirection({ oneway: '-1' })).toBe('backward')
    expect(onewayDirection({ oneway: 'no' })).toBe('both')
    expect(onewayDirection({})).toBe('both')

    expect(isRoutableRoad({ properties: { highway: 'residential' } })).toBe(true)
    expect(isRoutableRoad({ properties: { highway: 'service', access: 'private' } })).toBe(false)
    expect(isRoutableRoad({ properties: { highway: 'service', motor_vehicle: 'no' } })).toBe(false)
    expect(isRoutableRoad({ properties: { highway: 'tertiary', vehicle: 'no' } })).toBe(false)
  })

  it('excludes pedestrian-only ways from the Keke graph', () => {
    // A footpath is the ONLY link between two road stubs — Keke routing
    // must not use it (route honestly fails instead).
    const roadA = [7.41, 9.28]
    const roadB = [7.43, 9.3]
    const pathMiddle = [7.42, 9.29]
    const withPath = fc([
      lineFeature([roadA, [7.415, 9.285]]),
      lineFeature([[7.415, 9.285], pathMiddle, [7.425, 9.295]], { highway: 'footway' }),
      lineFeature([[7.425, 9.295], roadB]),
    ])
    const g = buildCampusGraph(withPath)
    const footway = withPath.features[1]
    expect(isRoutableRoad(footway)).toBe(false)

    const footwayMid = { lng: pathMiddle[0], lat: pathMiddle[1] }
    // The path's nodes never enter the graph, so a point beside it cannot
    // snap (nearest road stubs are ~700 m away).
    expect(routeOnGraph(g, footwayMid, { lng: roadB[0], lat: roadB[1] })).toBeNull()

    // Meanwhile a route between the road stubs via the graph… also fails:
    // the two stubs are separate components and only the largest survives.
    const stubRoute = routeOnGraph(g, { lng: roadA[0], lat: roadA[1] }, { lng: roadB[0], lat: roadB[1] })
    expect(stubRoute).toBeNull()

    // With the path present and routeable, the same trip works.
    const withRoadLink = fc([
      lineFeature([roadA, [7.415, 9.285]]),
      lineFeature([[7.415, 9.285], pathMiddle, [7.425, 9.295]]),
      lineFeature([[7.425, 9.295], roadB]),
    ])
    const g2 = buildCampusGraph(withRoadLink)
    expect(routeOnGraph(g2, { lng: roadA[0], lat: roadA[1] }, { lng: roadB[0], lat: roadB[1] })).not.toBeNull()
  })
})

describe('routeCampusTrip fallback chain', () => {
  it('uses the campus graph first and reports the local provider', async () => {
    const result = await routeCampusTrip(anchorByName['Hostel K'], MAIN_GATE, {
      graph,
      osrmFetch: () => Promise.reject(new Error('OSRM must not be consulted')),
    })
    expect(result.provider).toBe('campus-local')
    expect(result.fallback).toBe(false)
    expect(result.seconds).toBeNull()
    expect(result.meters).toBeGreaterThan(0)
    expect(result.coordinates.length).toBeGreaterThanOrEqual(2)
  })

  it('falls back to the OSRM provider when the local network cannot route', async () => {
    const osrmLine = [[7.41, 9.28], [7.415, 9.285], [7.42, 9.29]]
    const result = await routeCampusTrip({ lat: 9.35, lng: 7.5 }, MAIN_GATE, {
      graph,
      osrmFetch: () => Promise.resolve({ coordinates: osrmLine, meters: 640, seconds: 120 }),
    })
    expect(result.provider).toBe('osrm')
    expect(result.fallback).toBe(false)
    expect(result.coordinates).toEqual(osrmLine)
    expect(result.seconds).toBe(120)
  })

  it('returns a labelled direct line when no provider can route', async () => {
    const result = await routeCampusTrip({ lat: 9.35, lng: 7.5 }, MAIN_GATE, {
      fetchImpl: () => Promise.reject(new Error('offline')),
      osrmFetch: () => Promise.reject(new Error('offline')),
    })
    expect(result.fallback).toBe(true)
    expect(result.provider).toBeNull()
    expect(result.note).toBe(ROUTE_FALLBACK_NOTE)
    expect(result.coordinates).toHaveLength(2)
    expect(result.meters).toBeNull()
    expect(result.seconds).toBeNull()
  })

  it('returns null for unusable coordinates instead of requesting junk', async () => {
    expect(await routeCampusTrip(null, MAIN_GATE, { graph })).toBeNull()
    expect(await routeCampusTrip(anchorByName['Hostel K'], { lat: 0, lng: 0 }, { graph })).toBeNull()
  })
})

describe('loadCampusGraph', () => {
  it('fetches the real road file once and caches the built graph', async () => {
    let calls = 0
    const fetchImpl = async () => {
      calls += 1
      return {
        ok: true,
        text: async () => fs.readFileSync(path.join(mapsDir, 'veritas-campus-roads.geojson'), 'utf8'),
      }
    }

    const first = await loadCampusGraph({ fetchImpl })
    const second = await loadCampusGraph({ fetchImpl })
    expect(first).not.toBeNull()
    expect(first.edges.length).toBeGreaterThan(500)
    expect(second).toBe(first)
    expect(calls).toBe(1)
    expect(CAMPUS_ROADS_URL).toBe('/maps/veritas-campus-roads.geojson')
  })

  it('returns null on fetch failure and allows a later retry', async () => {
    const failing = () => Promise.reject(new Error('network down'))
    expect(await loadCampusGraph({ fetchImpl: failing })).toBeNull()

    // Failure must not poison the cache: a working fetch succeeds afterwards.
    const working = async () => ({
      ok: true,
      text: async () => fs.readFileSync(path.join(mapsDir, 'veritas-campus-roads.geojson'), 'utf8'),
    })
    const retry = await loadCampusGraph({ fetchImpl: working })
    expect(retry).not.toBeNull()
  })

  it('returns null for a non-GeoJSON response body', async () => {
    const bad = async () => ({ ok: true, text: async () => '<html>oops</html>' })
    expect(await loadCampusGraph({ fetchImpl: bad })).toBeNull()
  })
})

// Straight-line metres between two [lng, lat] pairs (local equirectangular
// is fine for the campus-scale assertion below).
function graphDistance(a, b) {
  const mLat = 111320
  const mLng = 111320 * Math.cos((a[1] * Math.PI) / 180)
  return Math.hypot((b[0] - a[0]) * mLng, (b[1] - a[1]) * mLat)
}
