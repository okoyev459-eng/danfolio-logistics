import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const mapsDir = path.resolve(process.cwd(), 'public/maps')
const readGeoJSON = (filename) => JSON.parse(
  fs.readFileSync(path.join(mapsDir, filename), 'utf8'),
)

describe('Veritas campus map starter data', () => {
  it('contains the 19 supplied campus reference anchors', () => {
    const data = readGeoJSON('veritas-campus-reference-anchors.geojson')
    expect(data.type).toBe('FeatureCollection')
    expect(data.features).toHaveLength(19)
    expect(data.features.every((feature) => feature.geometry.type === 'Point')).toBe(true)
  })

  it('keeps GeoJSON coordinates in longitude-latitude order and within campus bounds', () => {
    const data = readGeoJSON('veritas-campus-reference-anchors.geojson')
    for (const feature of data.features) {
      const [lng, lat] = feature.geometry.coordinates
      expect(lng).toBeGreaterThan(7.40)
      expect(lng).toBeLessThan(7.43)
      expect(lat).toBeGreaterThan(9.27)
      expect(lat).toBeLessThan(9.31)
    }
  })

  it('holds the imported OSM road network, buildings and an empty footpath layer', () => {
    const roads = readGeoJSON('veritas-campus-roads.geojson')
    expect(roads.type).toBe('FeatureCollection')
    // Successful OSM import (scripts/import-osm-campus.mjs): 53 roads.
    expect(roads.features).toHaveLength(53)
    expect(roads.features.every((feature) => feature.geometry?.type === 'LineString')).toBe(true)
    expect(roads.features.every((feature) => typeof feature.properties?.highway === 'string')).toBe(true)

    const buildings = readGeoJSON('veritas-campus-buildings.geojson')
    expect(buildings.type).toBe('FeatureCollection')
    // 30 building footprints — rendered as fill+outline, no labels.
    expect(buildings.features).toHaveLength(30)
    expect(
      buildings.features.every((feature) =>
        ['Polygon', 'MultiPolygon'].includes(feature.geometry?.type)),
    ).toBe(true)

    // Footpaths: none surveyed yet — a valid, EMPTY FeatureCollection that
    // the map must render without errors (never fabricated data).
    const footpaths = readGeoJSON('veritas-campus-footpaths.geojson')
    expect(footpaths.type).toBe('FeatureCollection')
    expect(footpaths.features).toEqual([])
  })

  it('includes the known main gate and hostel anchor records', () => {
    const data = readGeoJSON('veritas-campus-reference-anchors.geojson')
    const byName = new Map(data.features.map((feature) => [feature.properties.name, feature]))
    expect(byName.has('Main Gate')).toBe(true)
    expect(byName.get('Hostel N').properties.usage).toBe('pickup-only')
    expect(byName.get('Hostel M').properties.usage).toBe('pickup-only')
    expect(byName.get('Hostel K').properties.usage).toBe('pickup-and-drop-off')
  })
})
