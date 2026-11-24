#!/usr/bin/env node
/**
 * Convert an Overpass API JSON export (out geom) into the separate local
 * GeoJSON layers used by Danfolio. No dependencies are required.
 *
 * Usage:
 *   node scripts/import-osm-campus.mjs ./overpass-veritas-campus.json
 *
 * The script deliberately does not decide which access roads Kekes may use.
 * It preserves OSM access tags so the team can verify access on the ground.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const input = process.argv[2]
if (!input) {
  console.error('Usage: node scripts/import-osm-campus.mjs <overpass-export.json>')
  process.exit(1)
}

const raw = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'))
if (!Array.isArray(raw.elements)) {
  throw new Error('Input is not an Overpass JSON response: expected an elements array.')
}

const roads = []
const footpaths = []
const buildings = []

// Preserve manual Keke-access decisions from the previous import. The OSM
// source tags are refreshed, but a field-verified `keke_access: yes/no`
// decision belongs to Danfolio and must not be reset by the next import.
function previousRoadOverrides() {
  try {
    const filename = path.join(here, '../public/maps/veritas-campus-roads.geojson')
    const previous = JSON.parse(fs.readFileSync(filename, 'utf8'))
    return new Map((previous.features ?? []).map((feature) => [
      String(feature.properties?.osm_id ?? ''),
      {
        keke_access: feature.properties?.keke_access,
        keke_verified_at: feature.properties?.keke_verified_at,
        keke_verified_by: feature.properties?.keke_verified_by,
        keke_notes: feature.properties?.keke_notes,
      },
    ]))
  } catch {
    return new Map()
  }
}
const roadOverrides = previousRoadOverrides()
const roadTypes = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'service', 'track', 'road',
])
const pathTypes = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'bridleway'])

function wayFeature(element, geometryType, properties) {
  const coordinates = (element.geometry ?? [])
    .filter((p) => Number.isFinite(Number(p.lon)) && Number.isFinite(Number(p.lat)))
    .map((p) => [Number(p.lon), Number(p.lat)])
  if (coordinates.length < 2) return null
  if (geometryType === 'Polygon') {
    if (coordinates.length < 4) return null
    const first = coordinates[0]
    const last = coordinates.at(-1)
    if (first[0] !== last[0] || first[1] !== last[1]) coordinates.push([...first])
    return {
      type: 'Feature',
      id: `osm-way-${element.id}`,
      geometry: { type: 'Polygon', coordinates: [coordinates] },
      properties,
    }
  }
  return {
    type: 'Feature',
    id: `osm-way-${element.id}`,
    geometry: { type: 'LineString', coordinates },
    properties,
  }
}

for (const element of raw.elements) {
  if (element.type !== 'way' || !element.tags) continue
  const tags = element.tags
  const common = {
    osm_id: element.id,
    name: tags.name ?? tags.ref ?? '',
    highway: tags.highway ?? '',
    surface: tags.surface ?? '',
    access: tags.access ?? '',
    vehicle: tags.vehicle ?? '',
    motor_vehicle: tags.motor_vehicle ?? '',
    oneway: tags.oneway ?? '',
    width: tags.width ?? '',
    source: 'OpenStreetMap',
    raw_tags: tags,
  }

  if (tags.building) {
    const feature = wayFeature(element, 'Polygon', {
      osm_id: element.id,
      name: tags.name ?? '',
      building: tags.building,
      levels: tags['building:levels'] ?? '',
      source: 'OpenStreetMap',
      raw_tags: tags,
    })
    if (feature) buildings.push(feature)
    continue
  }

  if (roadTypes.has(tags.highway)) {
    const override = roadOverrides.get(String(element.id)) ?? {}
    const feature = wayFeature(element, 'LineString', {
      ...common,
      routeable_candidate: ![tags.access, tags.vehicle, tags.motor_vehicle]
        .some((value) => ['no', 'private'].includes(value)),
      keke_access: override.keke_access ?? 'verify-on-ground',
      keke_verified_at: override.keke_verified_at ?? '',
      keke_verified_by: override.keke_verified_by ?? '',
      keke_notes: override.keke_notes ?? '',
    })
    if (feature) roads.push(feature)
    continue
  }

  if (pathTypes.has(tags.highway)) {
    const feature = wayFeature(element, 'LineString', {
      ...common,
      walkable_candidate: !['no', 'private'].includes(tags.access),
      keke_access: 'no-unless-verified',
    })
    if (feature) footpaths.push(feature)
  }
}

const outDir = path.resolve(here, '../public/maps')
fs.mkdirSync(outDir, { recursive: true })
const meta = {
  coordinate_order: '[longitude, latitude]',
  crs: 'WGS84 / EPSG:4326',
  attribution: '© OpenStreetMap contributors',
  source: 'OpenStreetMap Overpass export; see docs/campus-map-digitization.md',
}
const outputs = [
  ['veritas-campus-roads.geojson', 'Veritas campus road network', roads],
  ['veritas-campus-footpaths.geojson', 'Veritas campus pedestrian paths', footpaths],
  ['veritas-campus-buildings.geojson', 'Veritas campus building footprints', buildings],
]
for (const [filename, name, features] of outputs) {
  fs.writeFileSync(path.join(outDir, filename), JSON.stringify({
    type: 'FeatureCollection', name, metadata: meta, features,
  }, null, 2) + '\n')
}
console.log(`Imported ${roads.length} roads, ${footpaths.length} paths and ${buildings.length} buildings.`)
console.log('Review road access tags and verify Keke access on the ground before using routes.')
