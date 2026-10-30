// Shared geo helpers (used by the map components, unit-tested in tests/).

// A coordinate is usable when both values are real numbers and not the 0,0
// placeholder some databases use for "unknown". Note: Number(null) === 0, so
// null/empty values must be rejected before conversion.
export function validCoord(point) {
  if (!point) return false
  const { lat, lng } = point
  const hasValue = (v) => v !== null && v !== undefined && v !== ''
  if (!hasValue(lat) || !hasValue(lng)) return false
  const nLat = Number(lat)
  const nLng = Number(lng)
  return (
    Number.isFinite(nLat) &&
    Number.isFinite(nLng) &&
    !(nLat === 0 && nLng === 0)
  )
}

// Great-circle distance in metres between two {lat, lng} points.
// Used to sort pick-up points by "nearest to me" and to label distances.
export function distanceMeters(a, b) {
  if (!validCoord(a) || !validCoord(b)) return null
  const R = 6371000 // Earth radius in metres
  const toRad = (d) => (Number(d) * Math.PI) / 180
  const dLat = toRad(Number(b.lat) - Number(a.lat))
  const dLng = toRad(Number(b.lng) - Number(a.lng))
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(h)))
}

// Human-friendly distance label ("350 m", "1.2 km").
export function formatDistance(meters) {
  if (!Number.isFinite(meters)) return ''
  if (meters < 1000) return `${meters} m`
  return `${(meters / 1000).toFixed(1)} km`
}

// Polygon ring approximating a circle of radiusM metres around (lng, lat).
// Used for the "my location" accuracy halo on the map.
export function circlePolygon(lng, lat, radiusM, steps = 64) {
  const ring = []
  const latR = radiusM / 111320
  const cos = Math.cos((Number(lat) * Math.PI) / 180) || 1
  const lngR = radiusM / (111320 * cos)
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    ring.push([Number(lng) + lngR * Math.cos(t), Number(lat) + latR * Math.sin(t)])
  }
  return ring
}

// Bottom-sheet snap physics. `snaps` holds translateY values per *visibility*
// index (index 0 = least visible / peek). `value` is the current translateY,
// `velocity` is px/ms (positive = finger moving down, i.e. towards peek).
// Returns the visibility index the sheet should settle on.
export function nearestSnap(value, snaps, velocity = 0) {
  if (!Array.isArray(snaps) || snaps.length === 0) return 0
  let best = 0
  for (let i = 1; i < snaps.length; i++) {
    if (Math.abs(snaps[i] - value) < Math.abs(snaps[best] - value)) best = i
  }
  if (Math.abs(velocity) > 0.45) {
    // A decisive flick moves one snap past the nearest one, in the drag
    // direction (down = towards peek = lower visibility index).
    const step = velocity > 0 ? -1 : 1
    best = Math.min(snaps.length - 1, Math.max(0, best + step))
  }
  return best
}
