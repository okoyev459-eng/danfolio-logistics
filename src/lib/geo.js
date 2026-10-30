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
