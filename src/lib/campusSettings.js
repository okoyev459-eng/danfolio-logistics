// campus_settings — the admin-configurable university campus name and map
// centre (spec section 4), stored as ONE row (id = 1) in Supabase.
//
// The coordinates have deliberately NOT been invented: until an admin saves
// them, every consumer falls back to VITE_MAP_CENTER / VITE_MAP_ZOOM and
// finally the historical default centre. Missing table (migration not yet
// applied) is a normal state here — never an error.
//
// Pure helpers are exported separately from the Supabase read so this module
// can be unit-tested without a client (tests/campusSettings.test.js).

// Veritas University campus (Abuja). This MUST match CampusMap's FALLBACK_CENTER
// and the coordinates stored on public.locations (≈ lat 9.285–9.296,
// lng 7.410–7.418). The previous value (8.4799, 4.5226) is Ilorin, ~600 km
// away, and campus_settings has no row yet — so every student map opened on
// the wrong part of Nigeria instead of the campus.
export const DEFAULT_CAMPUS_CENTER = { lat: 9.2895, lng: 7.416 }
export const DEFAULT_CAMPUS_ZOOM = 14

// Validation for the admin form. Returns { ok, errors } — never throws.
export function validateCampusSettings(input) {
  const errors = {}
  const name = String(input?.campus_name ?? '').trim()

  const rawLat = input?.center_lat
  const rawLng = input?.center_lng
  const emptyLat = rawLat === null || rawLat === undefined || String(rawLat).trim() === ''
  const emptyLng = rawLng === null || rawLng === undefined || String(rawLng).trim() === ''

  let center_lat = null
  let center_lng = null

  if (emptyLat !== emptyLng) {
    errors.center = 'Enter both latitude and longitude, or leave both empty.'
  } else if (!emptyLat) {
    center_lat = Number(rawLat)
    center_lng = Number(rawLng)
    if (!Number.isFinite(center_lat) || !Number.isFinite(center_lng)) {
      errors.center = 'Latitude and longitude must be numbers.'
    } else if (center_lat < -90 || center_lat > 90 || center_lng < -180 || center_lng > 180) {
      errors.center = 'Latitude must be −90…90 and longitude −180…180.'
    }
  }

  let zoom = null
  const rawZoom = input?.zoom
  if (rawZoom !== null && rawZoom !== undefined && String(rawZoom).trim() !== '') {
    zoom = Number(rawZoom)
    if (!Number.isInteger(zoom) || zoom < 1 || zoom > 20) {
      errors.zoom = 'Zoom must be a whole number between 1 and 20.'
      zoom = null
    }
  }

  if (name.length > 80) errors.campus_name = 'Keep the campus name under 80 characters.'

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    value: {
      id: 1,
      campus_name: name || null,
      center_lat,
      center_lng,
      zoom,
    },
  }
}

// The one row (id = 1) or null — tolerant of the table not existing yet and
// of any read failure: the map just falls back to defaults.
export async function loadCampusSettings(client) {
  if (!client) return null
  try {
    const { data, error } = await client
      .from('campus_settings')
      .select('campus_name, center_lat, center_lng, zoom, updated_at')
      .eq('id', 1)
      .maybeSingle()
    if (error) return null
    return data ?? null
  } catch {
    return null
  }
}

function envNumber(key) {
  try {
    const raw = Number(import.meta?.env?.[key])
    return Number.isFinite(raw) ? raw : null
  } catch {
    return null
  }
}

// ---- Per-page-load camera cache -------------------------------------------
// One Supabase read shared by every CampusMap on screen. The admin page
// calls resetCampusCameraCache() after saving so the next mount re-reads.
let cameraPromise = null

export function getCampusCamera(client) {
  if (!cameraPromise) {
    cameraPromise = Promise.resolve(loadCampusSettings(client))
      .then((settings) => resolveCampusCamera(settings))
      .catch(() => resolveCampusCamera(null))
  }
  return cameraPromise
}

export function resetCampusCameraCache() {
  cameraPromise = null
}

function envCenter() {
  try {
    const raw = String(import.meta?.env?.VITE_MAP_CENTER ?? '').trim()
    if (!raw) return null
    const [lat, lng] = raw.split(',').map((v) => Number(v.trim()))
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
    return { lat, lng }
  } catch {
    return null
  }
}

// Effective initial camera: Supabase row → VITE_MAP_* env → historical
// default. Returns { center: {lat,lng}, zoom, source }.
// NOTE: null/'' must be rejected before Number() — Number(null) === 0 would
// silently "invent" a centre at (0, x), the exact trap geo.js documents.
function finiteOrNull(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function resolveCampusCamera(settings) {
  const lat = finiteOrNull(settings?.center_lat)
  const lng = finiteOrNull(settings?.center_lng)
  const fromDb =
    lat !== null &&
    lng !== null &&
    lat >= -90 && lat <= 90 &&
    lng >= -180 && lng <= 180 &&
    { lat, lng }

  const center = fromDb || envCenter() || DEFAULT_CAMPUS_CENTER
  const envZoom = envNumber('VITE_MAP_ZOOM')
  const dbZoom = finiteOrNull(settings?.zoom)
  const zoomFromDb = dbZoom !== null && Number.isInteger(dbZoom) && dbZoom >= 1 && dbZoom <= 20
    ? dbZoom
    : null

  // Compare by VALUE, not identity: envCenter() returns a fresh object, so
  // `center !== DEFAULT_CAMPUS_CENTER` was always true and reported 'env'
  // even when the effective camera was the built-in default.
  const fromEnv = !fromDb && envCenter() !== null

  return {
    center,
    zoom: zoomFromDb ?? envZoom ?? DEFAULT_CAMPUS_ZOOM,
    source: fromDb ? 'settings' : fromEnv ? 'env' : 'default',
  }
}
