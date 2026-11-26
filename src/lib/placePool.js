// ONE place list for fares, booking and the home chips.
//
// `locations` can hold the same campus place more than once — one row per
// role (e.g. "Hostel A" as kind=pickup and "Hostel A" as kind=destination),
// because the booking function demanded a row whose kind matched the end of
// the trip. Admin screens then showed two unrelated lists: a short pick-up
// list and a long destination list.
//
// The app now treats those rows as one list of places: rows are grouped by
// name, and each place resolves to the row that fits the role being asked
// for. A place the admin entered only once still works as both a starting
// point and a destination.

export function placeKey(name) {
  return String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// The row kind that historically meant "you can start a trip here".
export function fromKindForMode(mode) {
  return mode === 'along' ? 'station' : 'pickup'
}

function hasPin(row) {
  return (
    row &&
    row.lat !== null &&
    row.lat !== undefined &&
    row.lat !== '' &&
    row.lng !== null &&
    row.lng !== undefined &&
    row.lng !== '' &&
    Number.isFinite(Number(row.lat)) &&
    Number.isFinite(Number(row.lng))
  )
}

// Group a mode's rows into places: one entry per name, never one per row.
export function buildPlacePool(rows, mode = null) {
  const preferredFromKind = fromKindForMode(mode)
  const byKey = new Map()

  for (const row of rows ?? []) {
    // A caller may leave the mode out of its SELECT when the query already
    // filtered by mode on the server, so only drop a row that carries a
    // different mode — never a row that simply didn't ask for the column.
    if (!row || (mode && row.mode != null && row.mode !== mode)) continue
    const key = placeKey(row.name)
    if (!key) continue

    let place = byKey.get(key)
    if (!place) {
      place = { key, name: String(row.name).trim(), category: '', rows: [] }
      byKey.set(key, place)
    }
    place.rows.push(row)
    if (!place.category && row.category) place.category = String(row.category).trim()
  }

  for (const place of byKey.values()) {
    place.fromRow = place.rows.find((r) => r.kind === preferredFromKind) ?? place.rows[0]
    place.toRow = place.rows.find((r) => r.kind === 'destination') ?? place.rows[0]
  }

  return [...byKey.values()]
}

// The row to send for `role` ('from' | 'to'), shaped like a location row so
// the pickers, the map and the fare lookup keep working unchanged.
export function placePoint(place, role = 'from') {
  if (!place) return null
  const row = (role === 'to' ? place.toRow : place.fromRow) ?? place.rows?.[0]
  if (!row) return null
  const pin = (place.rows ?? []).find(hasPin) ?? row
  return {
    ...row,
    id: row.id,
    name: place.name,
    category: place.category || row.category || '',
    kind: row.kind,
    lat: pin.lat,
    lng: pin.lng,
  }
}

// Every place in the mode, resolved for the role, minus `excludeKey` (the
// place already chosen for the other end — a trip never starts and ends at
// the same place).
export function placePoints(rows, mode, role = 'from', excludeKey = null) {
  return buildPlacePool(rows, mode)
    .filter((place) => place.key !== excludeKey)
    .map((place) => placePoint(place, role))
    .filter(Boolean)
}
