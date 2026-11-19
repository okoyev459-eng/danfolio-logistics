// Campus-local road routing over the imported OSM road GeoJSON.
//
// The remote OSRM demo server knows nothing about Veritas campus's internal
// roads (importing GeoJSON does not update a remote router), so the campus
// network is routed HERE: build a graph whose nodes are the road geometries'
// SHARED coordinates, then Dijkstra by road distance.
//
// Rules honoured (brief section 3):
//   - segments connect only through real shared coordinates (7 dp keys) —
//     no invented connections;
//   - one-way (oneway=yes/-1) and access bans (access/vehicle/motor_vehicle
//     = no/private/…) are respected;
//   - pedestrian-only ways (footway/path/steps/…) are excluded from Keke
//     routing;
//   - pick-up/destination snap onto the nearest routable edge within
//     SNAP_MAX_M; beyond that it is honestly "no local route";
//   - only the largest weakly-connected component is routable, so a route
//     returned here is always genuinely connected;
//   - when the local network cannot route, routeCampusTrip falls back to the
//     existing OSRM provider (lib/routing.js) and then to a clearly-labelled
//     direct line — never a fake "road route".
//
// Everything is pure/async-pure with injected fetch, unit-tested in
// tests/campusRouting.test.js against the REAL campus GeoJSON.

import { validCoord } from './geo.js'
import { ROUTE_FALLBACK_NOTE, fetchRoute } from './routing.js'

export const CAMPUS_ROADS_URL = '/maps/veritas-campus-roads.geojson'

// How far (metres) a pick-up/destination may sit from a routable road and
// still snap onto it. Campus locations sit close to roads; 80 m absorbs GPS
// error without pretending a car park 200 m away is "on" the road.
export const SNAP_MAX_M = 80

// Vehicle-only routing: pedestrian ways are never Keke roads.
const PEDESTRIAN_HIGHWAYS = new Set([
  'footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway',
  'corridor', 'platform', 'construction', 'proposed', 'raceway',
  'elevator', 'escalator', 'via_ferrata',
])

// Access values that ban a keke (motor vehicle).
const BANNED_ACCESS = new Set([
  'no', 'private', 'agricultural', 'forestry', 'delivery', 'customers',
  'permit', 'restricted', 'destination', 'through',
])

// ---- feature filters -------------------------------------------------------

export function isRoutableRoad(feature) {
  const props = feature?.properties ?? {}
  const highway = String(props.highway ?? '').toLowerCase()
  if (!highway) return false
  if (PEDESTRIAN_HIGHWAYS.has(highway)) return false
  for (const key of ['motor_vehicle', 'vehicle', 'access']) {
    const value = String(props[key] ?? '').toLowerCase()
    if (value && BANNED_ACCESS.has(value)) return false
  }
  return true
}

// 'forward' = a→b only, 'backward' = b→a only, 'both' = either way.
export function onewayDirection(props) {
  const value = String(props?.oneway ?? '').toLowerCase()
  if (value === 'yes' || value === 'true' || value === '1') return 'forward'
  if (value === '-1' || value === 'reverse') return 'backward'
  return 'both'
}

// ---- graph -----------------------------------------------------------------

// 7 decimal places ≈ 1.1 cm — shared vertices of the same OSM way (and of
// ways joined in OSM) produce the same key; rounding never merges distinct
// road coordinates at campus scale.
export function nodeKey(lng, lat) {
  return `${Number(lng).toFixed(7)}|${Number(lat).toFixed(7)}`
}

// Float haversine metres (geo.js distanceMeters rounds to integers, which
// would zero out short segments' contribution to route cost).
function segmentMeters(a, b) {
  const R = 6371000
  const toRad = (d) => (Number(d) * Math.PI) / 180
  const dLat = toRad(b[1] - a[1])
  const dLng = toRad(b[0] - a[0])
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// Build the routable graph from a roads FeatureCollection.
// Returns { nodes, edges, adj, excluded } — edges are undirected-capable
// ({a, b, meters, forward, backward}); adj is the DIRECTED adjacency used by
// Dijkstra. Only the largest weakly-connected component is kept, so every
// route the graph yields is connected.
export function buildCampusGraph(geojson) {
  const nodes = new Map()
  const edges = []
  const excluded = { nonRoad: 0, invalid: 0 }

  const ensureNode = (pair) => {
    const key = nodeKey(pair[0], pair[1])
    if (!nodes.has(key)) nodes.set(key, { lng: Number(pair[0]), lat: Number(pair[1]) })
    return key
  }

  for (const feature of geojson?.features ?? []) {
    if (!isRoutableRoad(feature)) {
      excluded.nonRoad += 1
      continue
    }
    const geometry = feature.geometry
    if (geometry?.type !== 'LineString' || !Array.isArray(geometry.coordinates)) {
      excluded.invalid += 1
      continue
    }
    const coords = geometry.coordinates
    if (coords.length < 2) {
      excluded.invalid += 1
      continue
    }
    const direction = onewayDirection(feature.properties)
    for (let i = 0; i < coords.length - 1; i += 1) {
      const pairA = coords[i]
      const pairB = coords[i + 1]
      if (!Array.isArray(pairA) || !Array.isArray(pairB) || pairA.length < 2 || pairB.length < 2) {
        excluded.invalid += 1
        continue
      }
      if (!Number.isFinite(Number(pairA[0])) || !Number.isFinite(Number(pairA[1])) ||
          !Number.isFinite(Number(pairB[0])) || !Number.isFinite(Number(pairB[1]))) {
        excluded.invalid += 1
        continue
      }
      const a = ensureNode(pairA)
      const b = ensureNode(pairB)
      if (a === b) continue // zero-length segment
      const meters = segmentMeters(pairA, pairB)
      if (!Number.isFinite(meters) || meters <= 0) continue
      edges.push({
        a,
        b,
        meters,
        forward: direction !== 'backward',
        backward: direction !== 'forward',
      })
    }
  }

  const kept = keepLargestComponent(nodes, edges)
  return {
    nodes: kept.nodes,
    edges: kept.edges,
    adj: adjacencyOf(kept.nodes, kept.edges),
    excluded,
  }
}

function adjacencyOf(nodes, edges) {
  const adj = new Map()
  for (const key of nodes.keys()) adj.set(key, [])
  const push = (from, to, meters) => {
    const list = adj.get(from)
    if (list) list.push({ to, meters })
  }
  for (const edge of edges) {
    if (edge.forward) push(edge.a, edge.b, edge.meters)
    if (edge.backward) push(edge.b, edge.a, edge.meters)
  }
  return adj
}

// Drop every node/edge outside the largest weakly-connected component
// (connectivity ignored for direction — a one-way exit still connects the
// component it belongs to).
function keepLargestComponent(nodes, edges) {
  if (edges.length === 0) return { nodes, edges }

  const undirected = new Map()
  for (const key of nodes.keys()) undirected.set(key, [])
  for (const edge of edges) {
    undirected.get(edge.a)?.push(edge.b)
    undirected.get(edge.b)?.push(edge.a)
  }

  const seen = new Set()
  let largest = []
  for (const start of nodes.keys()) {
    if (seen.has(start)) continue
    const component = []
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const key = stack.pop()
      component.push(key)
      for (const next of undirected.get(key) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    if (component.length > largest.length) largest = component
  }

  const keep = new Set(largest)
  const keptNodes = new Map()
  for (const key of largest) keptNodes.set(key, nodes.get(key))
  const keptEdges = edges.filter((edge) => keep.has(edge.a) && keep.has(edge.b))
  return { nodes: keptNodes, edges: keptEdges }
}

// ---- snapping --------------------------------------------------------------

// Project a point onto one segment in local metres (equirectangular around
// the query latitude — accurate to centimetres at campus scale).
function projectOnSegment(point, a, b) {
  const mPerDegLat = 111320
  const cosLat = Math.cos((Number(point.lat) * Math.PI) / 180) || 1
  const mPerDegLng = 111320 * cosLat

  const ax = (a.lng - point.lng) * mPerDegLng
  const ay = (a.lat - point.lat) * mPerDegLat
  const bx = (b.lng - point.lng) * mPerDegLng
  const by = (b.lat - point.lat) * mPerDegLat
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2
  t = Math.max(0, Math.min(1, t))
  const px = ax + t * dx
  const py = ay + t * dy
  return {
    lng: point.lng + px / mPerDegLng,
    lat: point.lat + py / mPerDegLat,
    t,
    dist: Math.hypot(px, py),
  }
}

// Nearest routable edge to `point` within maxM metres, or null.
// Works against a mutable edge list (re-run after a split).
function snapToEdge(nodes, edges, point, maxM) {
  let best = null
  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]
    const a = nodes.get(edge.a)
    const b = nodes.get(edge.b)
    if (!a || !b) continue
    const hit = projectOnSegment(point, a, b)
    if (hit.dist <= maxM && (!best || hit.dist < best.dist)) {
      best = { edgeIndex: i, ...hit }
    }
  }
  return best
}

// Split edge `edgeIndex` at the snapped point; returns the new node key
// (or the existing endpoint the snap landed on).
function splitEdge(nodes, edges, adj, edgeIndex, hit, counter) {
  const edge = edges[edgeIndex]
  if (hit.t <= 1e-9) return edge.a
  if (hit.t >= 1 - 1e-9) return edge.b

  const key = `@${Number(hit.lng).toFixed(7)}|${Number(hit.lat).toFixed(7)}#${counter}`
  nodes.set(key, { lng: Number(hit.lng), lat: Number(hit.lat) })
  if (!adj.has(key)) adj.set(key, [])

  const headMeters = edge.meters * hit.t
  const tailMeters = edge.meters - headMeters
  const head = { a: edge.a, b: key, meters: headMeters, forward: edge.forward, backward: edge.backward }
  const tail = { a: key, b: edge.b, meters: tailMeters, forward: edge.forward, backward: edge.backward }
  edges[edgeIndex] = head
  edges.push(tail)

  // Rewire the directed adjacency: remove a↔b, add the two halves.
  // (Removes ONE arc per direction — a parallel edge between the same node
  // pair, if ever present in the survey, keeps its own arc.)
  const remove = (from, to) => {
    const list = adj.get(from)
    if (!list) return
    const index = list.findIndex((entry) => entry.to === to)
    if (index >= 0) list.splice(index, 1)
  }
  remove(edge.a, edge.b)
  remove(edge.b, edge.a)
  const add = (from, to, meters) => adj.get(from)?.push({ to, meters })
  if (edge.forward) {
    add(edge.a, key, headMeters)
    add(key, edge.b, tailMeters)
  }
  if (edge.backward) {
    add(edge.b, key, tailMeters)
    add(key, edge.a, headMeters)
  }
  return key
}

// Minimal binary min-heap for Dijkstra (node counts here are small, but a
// heap keeps the hot loop honest if the survey grows).
function createHeap() {
  const items = []
  return {
    get size() { return items.length },
    push(item) {
      items.push(item)
      let i = items.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (items[parent].dist <= items[i].dist) break
        ;[items[parent], items[i]] = [items[i], items[parent]]
        i = parent
      }
    },
    pop() {
      if (items.length === 0) return null
      const top = items[0]
      const last = items.pop()
      if (items.length > 0) {
        items[0] = last
        let i = 0
        for (;;) {
          const left = i * 2 + 1
          const right = left + 1
          let smallest = i
          if (left < items.length && items[left].dist < items[smallest].dist) smallest = left
          if (right < items.length && items[right].dist < items[smallest].dist) smallest = right
          if (smallest === i) break
          ;[items[smallest], items[i]] = [items[i], items[smallest]]
          i = smallest
        }
      }
      return top
    },
  }
}

function dijkstra(adj, source, target) {
  if (source === target) return { path: [source], meters: 0 }
  const dist = new Map([[source, 0]])
  const prev = new Map()
  const done = new Set()
  const heap = createHeap()
  heap.push({ key: source, dist: 0 })

  while (heap.size > 0) {
    const { key, dist: d } = heap.pop()
    if (done.has(key)) continue
    if (d > (dist.get(key) ?? Infinity)) continue
    done.add(key)
    if (key === target) break
    for (const entry of adj.get(key) ?? []) {
      const next = d + entry.meters
      if (next < (dist.get(entry.to) ?? Infinity)) {
        dist.set(entry.to, next)
        prev.set(entry.to, key)
        heap.push({ key: entry.to, dist: next })
      }
    }
  }

  if (!done.has(target)) return null
  const path = [target]
  let cursor = target
  while (cursor !== source) {
    cursor = prev.get(cursor)
    if (cursor === undefined) return null
    path.push(cursor)
  }
  path.reverse()
  return { path, meters: dist.get(target) }
}

// Route between two coordinates on a built graph.
// Returns { coordinates, meters, seconds: null } or null (no snap / no
// connection). seconds is deliberately null: this router knows road
// DISTANCE exactly and must never fabricate a duration.
export function routeOnGraph(graph, from, to, { maxSnapM = SNAP_MAX_M } = {}) {
  if (!graph || !validCoord(from) || !validCoord(to)) return null

  const query = { lng: Number(from.lng), lat: Number(from.lat) }
  const target = { lng: Number(to.lng), lat: Number(to.lat) }

  // Working copies: snapping splits edges, which must not mutate the cache.
  const nodes = new Map(graph.nodes)
  const edges = graph.edges.map((edge) => ({ ...edge }))
  const adj = new Map()
  for (const [key, list] of graph.adj) adj.set(key, list.slice())

  const snapFrom = snapToEdge(nodes, edges, query, maxSnapM)
  if (!snapFrom) return null
  const fromKey = splitEdge(nodes, edges, adj, snapFrom.edgeIndex, snapFrom, 1)

  // Re-snap against the updated edge list so a pick-up and destination on
  // the SAME original road each land on the correct half.
  const snapTo = snapToEdge(nodes, edges, target, maxSnapM)
  if (!snapTo) return null
  const toKey = splitEdge(nodes, edges, adj, snapTo.edgeIndex, snapTo, 2)

  const result = dijkstra(adj, fromKey, toKey)
  if (!result) return null

  const coordinates = []
  const pushCoord = (lng, lat) => {
    const pair = [Number(lng), Number(lat)]
    const last = coordinates[coordinates.length - 1]
    if (!last || last[0] !== pair[0] || last[1] !== pair[1]) coordinates.push(pair)
  }
  for (const key of result.path) {
    const node = nodes.get(key)
    if (node) pushCoord(node.lng, node.lat)
  }
  // Zero-length path (both endpoints snap to the same road point): emit an
  // explicit two-point line — pushCoord's dedup would leave one point.
  if (coordinates.length === 1) coordinates.push([...coordinates[0]])
  if (coordinates.length < 2) return null

  return { coordinates, meters: Math.round(result.meters), seconds: null }
}

// ---- loading + full trip chain --------------------------------------------

function readGeoJSON(text) {
  try {
    const data = JSON.parse(text)
    return data?.type === 'FeatureCollection' && Array.isArray(data.features) ? data : null
  } catch {
    return null
  }
}

let graphCache = null

// Cached loader for the campus road graph. A failed fetch caches NOTHING, so
// a later call (reconnect / retry) can succeed; concurrent callers share one
// in-flight build.
export async function loadCampusGraph({ url = CAMPUS_ROADS_URL, fetchImpl } = {}) {
  if (graphCache) return graphCache

  const pending = (async () => {
    const doFetch = fetchImpl ?? globalThis.fetch
    if (typeof doFetch !== 'function') return null
    try {
      const response = await doFetch(url, { cache: 'no-cache' })
      if (!response?.ok) return null
      const data = readGeoJSON(await response.text())
      if (!data) return null
      const graph = buildCampusGraph(data)
      return graph.edges.length > 0 ? graph : null
    } catch {
      return null
    }
  })()

  graphCache = pending
  const graph = await pending
  if (!graph) graphCache = null
  return graph
}

export function resetCampusGraphCache() {
  graphCache = null
}

// Full trip chain: campus-local road graph → OSRM provider → direct line.
// Never throws; always returns a drawable result for valid coordinates:
//   { coordinates, meters, seconds, provider: 'campus-local'|'osrm'|null,
//     fallback: boolean, note? }
// fallback:true carries ROUTE_FALLBACK_NOTE — the caller must render it as a
// direct line, never as a road route.
// `graph` may be passed to skip the GeoJSON load (tests / callers that
// already hold the built graph).
export async function routeCampusTrip(from, to, { fetchImpl, maxSnapM, graph, osrmFetch = fetchRoute } = {}) {
  if (!validCoord(from) || !validCoord(to)) return null

  try {
    const localGraph = graph ?? await loadCampusGraph({ fetchImpl })
    if (localGraph) {
      const local = routeOnGraph(localGraph, from, to, { maxSnapM })
      if (local) {
        return { ...local, provider: 'campus-local', fallback: false }
      }
    }
  } catch {
    // Local routing problems fall through to the supported providers.
  }

  let remote = null
  try {
    remote = await osrmFetch(from, to, { fetchImpl })
  } catch {
    remote = null
  }
  if (remote) {
    return {
      coordinates: remote.coordinates,
      meters: remote.meters,
      seconds: remote.seconds,
      provider: 'osrm',
      fallback: false,
    }
  }

  return {
    coordinates: [
      [Number(from.lng), Number(from.lat)],
      [Number(to.lng), Number(to.lat)],
    ],
    meters: null,
    seconds: null,
    provider: null,
    fallback: true,
    note: ROUTE_FALLBACK_NOTE,
  }
}
