import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { circlePolygon, validCoord } from '../lib/geo'
import { ROUTE_FALLBACK_NOTE } from '../lib/routing'
import { routeCampusTrip } from '../lib/campusRouting'
import { KEKE_STATE_LABELS, kekeMarkerState, positionFreshness } from '../lib/tracking'
import { getCampusCamera, resetCampusCameraCache } from '../lib/campusSettings'
import { supabase } from '../lib/supabase'

// CampusMap — the app's only map renderer.
//
// Free stack only (no billing account, no API key):
//   - MapLibre GL JS   rendering (BSD-3-Clause, in package.json)
//   - OpenFreeMap       default map tiles + style (https://openfreemap.org)
//   - OpenStreetMap     underlying map data (© OpenStreetMap contributors)
//
// Provider configuration (see docs/map-and-live-tracking.md):
//   - VITE_MAP_STYLE_URL — any MapLibre style URL (tiles + style together);
//   - VITE_ROUTING_URL   — any OSRM-compatible routing base (lib/routing.js);
//   - campus centre/zoom — the admin's campus_settings row (DB), then
//     VITE_MAP_CENTER / VITE_MAP_ZOOM, then the historical default.
//
// Routing and address search are deliberately separate concerns:
//   - Routing: via the configured OSRM-compatible provider, drawn as a real
//     road path with distance + duration. If the provider fails, the map
//     draws a DASHED direct line labelled as such — never passed off as a
//     road route — and reports no ETA.
//   - Address search: NOT provided. Students choose from the admin's fixed
//     location lists (spec section 1), which is the product requirement.
//
// Markers:
//   - location pins are colour-coded by kind (pickup/station/destination);
//     the `selectedId` pin gets a highlight ring;
//   - keke riders render as distinct vehicle badges (navy = nearby, blue +
//     pulsing = your assigned rider via `highlight`);
//   - the student's own position renders as a cyan dot with an accuracy halo;
//   - a MANUAL pick-up pin (amber, draggable, `manualPickup` prop) renders
//     only when a parent passes one — visually distinct from the GPS dot,
//     with a "Use my GPS location" button to swap back (props: onUseGps /
//     onManualPickupChange; optional honest GPS status overlay via
//     locationState + onLocationRetry).
//   Markers are RECONCILED, not rebuilt: live position updates move the
//   existing keke badge with a display-only ~1 s tween between two real GPS
//   fixes (no intermediate coordinates are invented as data), and the
//   blue dot + accuracy circle are updated in place (setLngLat / setData).
//
// Camera: the view auto-fits when the SET of pins changes (ids), not on
//   every live position tick, so a moving keke never yanks the camera.
//   Parents can drive the camera imperatively via the ref API:
//   { zoomIn, zoomOut, recenter, fitPoints(points) }
//
// Attribution: MapLibre's AttributionControl is added explicitly and cannot
// be disabled here — OSM/OpenFreeMap terms require it.

// Liberty is a conventional, street-first style for the campus map.
// It uses OpenFreeMap vector tiles backed by OpenStreetMap data.
const FALLBACK_STYLE = 'https://tiles.openfreemap.org/styles/liberty'

// Danfolio's own traced campus vectors live in public/maps. They start empty
// intentionally and are populated only from verified campus mapping data.
const CAMPUS_VECTOR_FILES = {
  roads: '/maps/veritas-campus-roads.geojson',
  footpaths: '/maps/veritas-campus-footpaths.geojson',
  buildings: '/maps/veritas-campus-buildings.geojson',
}

const EMPTY_FEATURE_COLLECTION = { type: 'FeatureCollection', features: [] }

async function loadCampusGeoJSON(url) {
  try {
    const response = await fetch(url, { cache: 'no-cache' })
    if (!response.ok) return EMPTY_FEATURE_COLLECTION
    const data = await response.json()
    return data?.type === 'FeatureCollection' && Array.isArray(data.features)
      ? data
      : EMPTY_FEATURE_COLLECTION
  } catch {
    // The base map remains usable while local campus vectors are not yet
    // available (for example, before the first mapping import).
    return EMPTY_FEATURE_COLLECTION
  }
}

function firstSymbolLayerId(map) {
  return map.getStyle()?.layers?.find((layer) => layer.type === 'symbol')?.id
}

// Add Danfolio's campus vector sources + layers to an already-loaded
// style. Idempotent (guards on getSource/getLayer), so a re-run after a
// style reload adds exactly what is missing. Throws to the caller.
function addCampusVectorLayers(map, { roads, footpaths, buildings }) {
  const beforeId = firstSymbolLayerId(map)
  const sources = [
    ['danfolio-campus-roads', roads],
    ['danfolio-campus-footpaths', footpaths],
    ['danfolio-campus-buildings', buildings],
  ]
  for (const [id, data] of sources) {
    if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data })
  }

  const add = (layer) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer, beforeId)
  }

  // Building footprints are deliberately understated so labels and
  // location pins remain readable above them.
  add({
    id: 'danfolio-campus-buildings-fill',
    type: 'fill',
    source: 'danfolio-campus-buildings',
    paint: { 'fill-color': '#CBD5E1', 'fill-opacity': 0.42 },
  })
  add({
    id: 'danfolio-campus-buildings-outline',
    type: 'line',
    source: 'danfolio-campus-buildings',
    paint: { 'line-color': '#64748B', 'line-width': 1, 'line-opacity': 0.8 },
  })
  add({
    id: 'danfolio-campus-roads-casing',
    type: 'line',
    source: 'danfolio-campus-roads',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#FFFFFF',
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 3, 18, 8],
      'line-opacity': 0.96,
    },
  })
  add({
    id: 'danfolio-campus-roads-line',
    type: 'line',
    source: 'danfolio-campus-roads',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'match', ['get', 'highway'],
        'primary', '#D97706',
        'secondary', '#D97706',
        'tertiary', '#B7791F',
        '#64748B',
      ],
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 18, 4.5],
      'line-opacity': 0.98,
    },
  })
  add({
    id: 'danfolio-campus-footpaths-line',
    type: 'line',
    source: 'danfolio-campus-footpaths',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': '#94A3B8',
      'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 19, 2.2],
      'line-dasharray': [2, 2],
      'line-opacity': 0.9,
    },
  })
  // No road-name or building-name label layers: the brief keeps
  // this map clean (subtle roads + outlines only) — street names
  // and building labels would clutter the tracking view.
}
const FALLBACK_CENTER = [7.41431, 9.290626] // midpoint of supplied campus locations
const FALLBACK_ZOOM = 14

function envStyle() {
  try {
    const value = String(import.meta?.env?.VITE_MAP_STYLE_URL ?? '').trim()
    return value || FALLBACK_STYLE
  } catch {
    return FALLBACK_STYLE
  }
}

const KIND_COLORS = {
  pickup: '#1E3A8A',
  station: '#2563EB',
  destination: '#0EA5E9',
}

const KEKE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 11l1.5-4.2A2 2 0 0 1 8.4 5.5h7.2a2 2 0 0 1 1.9 1.3L19 11M5 11h14M5 11a2 2 0 0 0-2 2v3.5h2M19 11a2 2 0 0 1 2 2v3.5h-2M5 16.5V19m14-2.5V19M7.5 14h.5m8 0h.5"/></svg>'

// Heartbeat state of one keke row — pure wrapper over tracking.js so every
// screen (home, booking, ride) classifies live / stale / offline identically.
function stateOf(keke) {
  return kekeMarkerState({
    status: keke.status,
    // Only the GPS heartbeat proves a fresh position. General row updates
    // (updated_at) must never make an old coordinate look live.
    last_seen: keke.last_seen,
  })
}

// State colour class: amber = updating slowly, grey = no live location.
function stateClass(state) {
  if (state === 'stale') return ' km-keke-stale'
  if (state === 'offline' || state === 'unavailable') return ' km-keke-offline'
  return ''
}

// Popup wording: state in plain words + the REAL heartbeat age (never a
// claim like "live" off a five-minute-old fix).
function escapePopupText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character])
}

function kekePopupHTML(keke, state) {
  const stamp = keke.last_seen
  const age = stamp ? positionFreshness(stamp).label : 'no GPS yet'
  const label = KEKE_STATE_LABELS[state] ?? 'Location unknown'
  return (
    `<b>Keke ${escapePopupText(keke.keke_number)}</b>${keke.highlight ? ' · your rider' : ''}` +
    `<br><span class="km-state-${escapePopupText(state)}">${escapePopupText(label)}</span> — ${escapePopupText(age)}`
  )
}

function makeKekeElement(highlight, state) {
  const el = document.createElement('div')
  el.className = 'km-keke' + stateClass(state) + (highlight ? ' km-keke-hi' : '')
  el.innerHTML = KEKE_SVG
  return el
}

// ---- Campus camera (admin's campus_settings row, cached per page load) ----
// (cache lives in lib/campusSettings so the admin page can reset it)

// Display-only tween between two REAL fixes (both endpoints are measured
// GPS positions; the intermediate frames are animation, not data).
// ~1 s glide (task 4): long enough to read as motion on a phone, short
// enough that the badge never looks "behind" the truth.
const TWEEN_MS = 1000
const TWEEN_MAX_DEG = 0.005 // ~500 m — beyond that, snap instead of gliding
function tweenMarker(marker, from, to) {
  const start = performance.now()
  marker._kmTweenTo = to
  const step = (t) => {
    // Belt-and-braces with the visibilitychange snap below: if a frame does
    // land while hidden, land on the REAL target instead of animating.
    if (typeof document !== 'undefined' && document.hidden) {
      marker.setLngLat(to)
      marker._kmTween = null
      marker._kmTweenTo = null
      return
    }
    const p = Math.min(1, (t - start) / TWEEN_MS)
    const eased = 1 - (1 - p) ** 2
    marker.setLngLat([
      from[0] + (to[0] - from[0]) * eased,
      from[1] + (to[1] - from[1]) * eased,
    ])
    if (p < 1) {
      marker._kmTween = requestAnimationFrame(step)
    } else {
      marker._kmTween = null
      marker._kmTweenTo = null
    }
  }
  marker._kmTween = requestAnimationFrame(step)
}

// Amber manual pick-up pin — deliberately NOT the cyan GPS dot (task 2):
// different shape, colour and a persistent "Pick-up" label, so "the point
// I chose" can never be mistaken for "where I actually am".
const PICKUP_SVG =
  '<svg viewBox="0 0 24 32" fill="#F59E0B" stroke="#FFFFFF" stroke-width="1.6" ' +
  'stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M12 1.5A8.5 8.5 0 0 0 3.5 10c0 6.4 8.5 20 8.5 20s8.5-13.6 8.5-20A8.5 8.5 0 0 0 12 1.5z"/>' +
  '<circle cx="12" cy="10" r="3.2" fill="#FFFFFF" stroke="none"/></svg>'

// Honest GPS wording — mirrors the student home / booking panel messages
// (same words, so the app never contradicts itself).
const GPS_STATUS_MESSAGES = {
  denied: 'Location access is off — turn it on to see your position on the map.',
  insecure: 'Location is blocked because this page is open over plain http:// — open the app over HTTPS.',
  unavailable: 'Your location is unavailable right now — you can still browse the campus map.',
  timeout: 'Your location is unavailable right now — you can still browse the campus map.',
}

// Two-point (direct) lines have nothing to reveal frame-by-frame. Split a
// STRAIGHT segment into collinear points — the geometry is identical, only
// the drawing progress is animated. Road routes already arrive with many
// points and are passed through unchanged.
function subdivideStraight(line, pieces = 24) {
  if (!Array.isArray(line) || line.length !== 2) return line
  const [[x1, y1], [x2, y2]] = line
  const out = []
  for (let i = 0; i <= pieces; i++) {
    const t = i / pieces
    out.push([x1 + (x2 - x1) * t, y1 + (y2 - y1) * t])
  }
  return out
}

const CampusMap = forwardRef(function CampusMap(
  {
    points = [],
    kekes = [],
    route = null,
    height = 260,
    interactive = true,
    onSelect = null,
    onRouteInfo = null,
    userLocation = null,
    userAccuracy = null,
    // Manual pick-up (task 2): a controlled pin set by tapping the map or
    // dragging, deliberately separate from the GPS dot. Parents opt in via
    // props — with none passed, the map behaves exactly as before.
    manualPickup = null,
    onManualPickupChange = null,
    onUseGps = null,
    // Optional honest GPS status overlay ("Location unavailable" + retry)
    // driven by the parent's useGeolocation state.
    locationState = null,
    onLocationRetry = null,
    selectedId = null,
    animate = false,
    navControls = true,
    onReady = null,
    onFail = null,
    onMapClick = null,
  },
  ref,
) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const pointMarkersRef = useRef(new Map())
  const kekeMarkersRef = useRef(new Map())
  const userMarkerRef = useRef(null)
  const pickupMarkerRef = useRef(null)
  // Last drawn accuracy-circle key (lng,lat,radius) — avoids re-writing the
  // polygon data when the fix has not meaningfully changed.
  const userCircleKeyRef = useRef(null)
  const [failed, setFailed] = useState(false)
  const [basemapWarning, setBasemapWarning] = useState('')
  const [routeNote, setRouteNote] = useState('')
  // Style-dependent work (sources/layers) must wait until the style has
  // loaded — MapLibre throws synchronously (crashing React) if addSource
  // runs too early. Markers are DOM-only and may be created immediately.
  const [styleReady, setStyleReady] = useState(false)
  // Incremented on every style.load (including style reloads) so our
  // sources/layers are re-added after MapLibre wipes them on setStyle.
  const [styleEpoch, setStyleEpoch] = useState(0)
  // `style.load` has fired for the CURRENT map = the style JSON is applied
  // and addSource/addLayer are safe. Deliberately NOT isStyleLoaded(),
  // which stays false until every viewport tile + sprite finishes loading
  // (a slow network would then be misread as a dead map).
  const styleLoadedRef = useRef(false)
  const [retryKey, setRetryKey] = useState(0)
  // Keke states must AGE even when no new rows arrive (a rider whose phone
  // dies stops publishing — the badge must turn stale on its own).
  const [stateTick, setStateTick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => setStateTick((n) => n + 1), 15000)
    return () => window.clearInterval(timer)
  }, [])
  const cameraAppliedRef = useRef(false)
  // Successful pin-driven fits. The campus-camera fallbacks (init effect +
  // auto-fit effect) are async — they must never stomp a fit that landed
  // while they were resolving, or the view snaps back to the campus
  // default far away from the ride (the "wrong location" bug).
  const dataFitRef = useRef(0)
  const routeModeRef = useRef(null) // 'road' | 'direct' | null
  // Active route-draw animation (rAF handle) — cancelled on redraw/unmount.
  const routeAnimRef = useRef(null)

  // Keep the latest callbacks in refs so effects never re-run just because
  // the parent re-created a function.
  const onRouteInfoRef = useRef(onRouteInfo)
  onRouteInfoRef.current = onRouteInfo
  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onFailRef = useRef(onFail)
  onFailRef.current = onFail
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const onMapClickRef = useRef(onMapClick)
  onMapClickRef.current = onMapClick
  const onManualPickupChangeRef = useRef(onManualPickupChange)
  onManualPickupChangeRef.current = onManualPickupChange
  const suppressClickRef = useRef(0)
  const interactedRef = useRef(false)

  const pointsKey = JSON.stringify(points)
  const kekesKey = JSON.stringify(kekes)
  const userKey = JSON.stringify([userLocation, userAccuracy])

  // Auto-fit keys use only the SET of ids — live keke position updates
  // change positions, not ids, so the camera stays put while riders move.
  const pointsIdsKey = JSON.stringify(
    points.filter(validCoord).map((p) => p.id ?? p.name).sort(),
  )
  const kekesIdsKey = JSON.stringify(
    kekes.filter(validCoord).map((k) => k.id ?? `${k.lat},${k.lng}`).sort(),
  )

  function fitList(list) {
    const map = mapRef.current
    if (!map) return false
    const bounds = new maplibregl.LngLatBounds()
    let ok = false
    for (const p of list ?? []) {
      if (!validCoord(p)) continue
      bounds.extend([Number(p.lng), Number(p.lat)])
      ok = true
    }
    if (ok) {
      // Short map bands (the homepage's ⅓-screen map) need proportionally
      // less padding — a flat 60 px on every side would shrink the campus
      // to a dot on a 200 px-tall container.
      const box = map.getContainer()
      const padV = Math.max(18, Math.min(60, Math.round((box.clientHeight || 300) * 0.12)))
      const padH = Math.max(18, Math.min(60, Math.round((box.clientWidth || 400) * 0.08)))
      map.fitBounds(bounds, {
        padding: { top: padV, bottom: padV, left: padH, right: padH },
        maxZoom: 16,
        duration: animate ? 900 : 0,
      })
    }
    return ok
  }

  // ---- Marker collision pass ---------------------------------------------
  // MapLibre draws markers independently, so two pins at the same spot
  // stack. On every camera move we project each marker's TRUE coordinate
  // and dim only the occluded copies (`.km-collide`) — positions are never
  // shifted, and priority keeps the important badges visible:
  //   0 selected pin → 1 your rider → 2 other kekes → 3 location pins.
  const collisionQueuedRef = useRef(false)
  const updateCollisions = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    const items = []
    for (const [, entry] of pointMarkersRef.current) {
      items.push({
        el: entry.marker.getElement(),
        prio: entry.marker.getElement().classList.contains('km-point-sel') ? 0 : 3,
        pos: entry.marker.getLngLat(),
      })
    }
    for (const [, entry] of kekeMarkersRef.current) {
      items.push({
        el: entry.marker.getElement(),
        prio: entry.highlight ? 1 : 2,
        pos: entry.marker.getLngLat(),
      })
    }
    items.sort((a, b) => a.prio - b.prio)

    const kept = []
    const THRESHOLD = 28 // px between marker centres ≈ visual overlap
    for (const item of items) {
      const p = map.project([item.pos.lng, item.pos.lat])
      const clash = kept.some(
        (k) => Math.hypot(k.x - p.x, k.y - p.y) < THRESHOLD,
      )
      if (clash) item.el.classList.add('km-collide')
      else {
        item.el.classList.remove('km-collide')
        kept.push(p)
      }
    }
  }, [])
  const scheduleCollisions = useCallback(() => {
    if (collisionQueuedRef.current) return
    collisionQueuedRef.current = true
    requestAnimationFrame(() => {
      collisionQueuedRef.current = false
      updateCollisions()
    })
  }, [updateCollisions])

  function clearAllMarkers() {
    for (const entry of pointMarkersRef.current.values()) {
      entry.marker.remove()
    }
    pointMarkersRef.current.clear()
    for (const entry of kekeMarkersRef.current.values()) {
      if (entry.marker._kmTween) cancelAnimationFrame(entry.marker._kmTween)
      entry.marker.remove()
    }
    kekeMarkersRef.current.clear()
    userMarkerRef.current?.remove()
    userMarkerRef.current = null
    pickupMarkerRef.current?.remove()
    pickupMarkerRef.current = null
  }

  function retryMap() {
    setFailed(false)
    setStyleReady(false)
    setBasemapWarning('')
    setRetryKey((value) => value + 1)
  }

  // Imperative camera API for parent controls (zoom / recenter / fit).
  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => mapRef.current?.zoomIn(),
      zoomOut: () => mapRef.current?.zoomOut(),
      recenter: () => {
        const map = mapRef.current
        if (!map || !validCoord(userLocation)) return false
        map.easeTo({
          center: [Number(userLocation.lng), Number(userLocation.lat)],
          zoom: Math.max(map.getZoom(), 16),
          duration: 700,
        })
        return true
      },
      fitPoints: (list) => fitList(list ?? []),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userLocation],
  )

  // Create the map exactly once per mount (StrictMode-safe).
  useEffect(() => {
    if (!containerRef.current || mapRef.current || failed) return

    let map
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: envStyle(),
        center: FALLBACK_CENTER,
        zoom: FALLBACK_ZOOM,
        attributionControl: false,
        interactive,
      })
    } catch {
      setFailed(true)
      onFailRef.current?.()
      return
    }

    mapRef.current = map
    map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>',
    }))
    if (interactive && navControls) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    }
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left')

    // A user gesture must never be overridden by a late camera apply.
    const markInteracted = () => { interactedRef.current = true }
    for (const type of ['mousedown', 'wheel', 'touchstart', 'keydown']) {
      map.getContainer().addEventListener(type, markInteracted, { passive: true })
    }

    // Admin campus centre: apply once the settings row resolves, but only if
    // the user has not already grabbed the map (and no pins have taken over).
    getCampusCamera(supabase).then((camera) => {
      if (mapRef.current !== map || interactedRef.current) return
      if (cameraAppliedRef.current) return
      if (dataFitRef.current > 0) return // pins already framed the view
      cameraAppliedRef.current = true
      map.jumpTo({
        center: [camera.center.lng, camera.center.lat],
        zoom: camera.zoom,
      })
    }).catch(() => {})

    map.on('click', (event) => {
      if (!onMapClickRef.current && !onManualPickupChangeRef.current) return
      if (Date.now() - suppressClickRef.current < 300) return // marker tap
      const lat = Number(event.lngLat.lat.toFixed(6))
      const lng = Number(event.lngLat.lng.toFixed(6))
      if (onMapClickRef.current) onMapClickRef.current({ lat, lng })
      // Tapping empty map = choosing a manual pick-up point (task 2).
      if (onManualPickupChangeRef.current) onManualPickupChangeRef.current({ lat, lng })
    })

    // Keep occluded markers dimmed while the camera moves.
    map.on('move', scheduleCollisions)
    map.on('resize', scheduleCollisions)

    const onMapError = (event) => {
      // A superseded/removed map (StrictMode double-mount, retry) must never
      // fail the LIVE map, and an aborted request caused by our own teardown
      // is not a basemap failure.
      if (mapRef.current !== map) return
      // Keep location markers visible, but never silently present them as a
      // complete road map when the basemap's vector tiles or resources fail.
      const message = String(event?.error?.message ?? '')
      if (/abort/i.test(message)) return
      const styleSources = map.getStyle()?.sources ?? {}
      const styleSourceFailure = Boolean(
        event?.sourceId && Object.prototype.hasOwnProperty.call(styleSources, event.sourceId),
      )
      const tileFailure = Boolean(event?.tile && (!event?.sourceId || styleSourceFailure))
      const resourceFailure = /tile|sprite|glyph|fetch|network|failed to load/i.test(message)

      if (styleSourceFailure || tileFailure || (styleLoadedRef.current && resourceFailure)) {
        setBasemapWarning(
          'Some road-map details could not be loaded. Check your connection and retry the map.',
        )
      } else if (!styleLoadedRef.current) {
        setFailed(true)
        onFailRef.current?.()
      }
    }
    map.on('error', onMapError)

    // The style can be ready even while a few vector tiles are still
    // downloading. Add our route and accuracy layers at style.load rather
    // than waiting for the full first map load.
    // `on` (not `once`): a later style reload wipes our sources/layers, so
    // every style.load bumps the epoch and re-runs the add-effects below.
    const onStyleLoad = () => {
      if (mapRef.current !== map) return
      styleLoadedRef.current = true
      setStyleReady(true)
      setStyleEpoch((value) => value + 1)
      onReadyRef.current?.()
    }
    map.on('style.load', onStyleLoad)

    // A failed tile can still leave MapLibre reporting the viewport as
    // idle. Keep the warning visible until the user retries the map; this
    // avoids hiding a missing-road-map problem behind a successful style load.

    // Distinguish a failed style from failed road tiles. The style-load
    // ref tells us whether the style JSON ever arrived; viewport tiles can
    // legitimately still be streaming in (isStyleLoaded() covers those and
    // must not be used to fail the map). Slow tiles get a warning instead.
    const timer = window.setTimeout(() => {
      if (mapRef.current !== map) return
      if (!styleLoadedRef.current) {
        setFailed(true)
        onFailRef.current?.()
      } else if (!map.areTilesLoaded()) {
        setBasemapWarning(
          'The road map is taking too long to load. Check your connection and retry.',
        )
      }
    }, 12000)

    return () => {
      window.clearTimeout(timer)
      // Detach state-writing handlers BEFORE teardown: map.remove() aborts
      // the in-flight style request, and that abort must not reach React.
      map.off('error', onMapError)
      map.off('style.load', onStyleLoad)
      styleLoadedRef.current = false
      for (const type of ['mousedown', 'wheel', 'touchstart', 'keydown']) {
        map.getContainer().removeEventListener(type, markInteracted)
      }
      clearAllMarkers()
      map.remove()
      mapRef.current = null
    }
  }, [interactive, navControls, failed, retryKey])

  // Reconcile location + keke markers with props (update in place; never a
  // full teardown — live GPS updates must not flicker).
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed) return

    // ---- location pins ----
    const seenPoints = new Set()
    for (const point of points) {
      if (!validCoord(point)) continue
      const key = String(point.id ?? point.name)
      seenPoints.add(key)

      let entry = pointMarkersRef.current.get(key)
      if (!entry) {
        const color = KIND_COLORS[point.kind] ?? '#2563EB'
        const marker = new maplibregl.Marker({ color })
          .setLngLat([Number(point.lng), Number(point.lat)])
          .setPopup(new maplibregl.Popup().setHTML(`<b>${escapePopupText(point.name ?? 'Point')}</b>`))
          .addTo(map)

        if (onSelectRef.current) {
          marker.getElement().addEventListener('click', () => {
            suppressClickRef.current = Date.now()
            onSelectRef.current?.(point)
          })
        }

        entry = { marker, name: point.name }
        pointMarkersRef.current.set(key, entry)
      } else {
        entry.marker.setLngLat([Number(point.lng), Number(point.lat)])
        if (entry.name !== point.name) {
          entry.name = point.name
          entry.marker.getPopup().setHTML(`<b>${escapePopupText(point.name ?? 'Point')}</b>`)
        }
      }

      entry.marker
        .getElement()
        .classList.toggle('km-point-sel', Boolean(selectedId) && key === String(selectedId))
    }
    for (const [key, entry] of pointMarkersRef.current) {
      if (!seenPoints.has(key)) {
        entry.marker.remove()
        pointMarkersRef.current.delete(key)
      }
    }

    // ---- keke badges ----
    const seenKekes = new Set()
    for (const keke of kekes) {
      if (!validCoord(keke)) continue
      const key = String(keke.id ?? `${keke.lat},${keke.lng}`)
      seenKekes.add(key)

      const state = stateOf(keke)
      const highlight = Boolean(keke.highlight)

      let entry = kekeMarkersRef.current.get(key)
      if (!entry) {
        const marker = new maplibregl.Marker({
          element: makeKekeElement(highlight, state),
          anchor: 'center',
        })
          .setLngLat([Number(keke.lng), Number(keke.lat)])
          .setPopup(new maplibregl.Popup().setHTML(kekePopupHTML(keke, state)))
          .addTo(map)
        entry = { marker, highlight, state, number: keke.keke_number ?? '' }
        kekeMarkersRef.current.set(key, entry)
      } else {
        const target = [Number(keke.lng), Number(keke.lat)]
        const current = entry.marker.getLngLat()
        const moved =
          Math.abs(current.lng - target[0]) > 1e-9 ||
          Math.abs(current.lat - target[1]) > 1e-9

        if (moved) {
          if (entry.marker._kmTween) cancelAnimationFrame(entry.marker._kmTween)
          const bigJump =
            Math.abs(current.lng - target[0]) > TWEEN_MAX_DEG ||
            Math.abs(current.lat - target[1]) > TWEEN_MAX_DEG
          if (bigJump) {
            entry.marker._kmTween = null
            entry.marker.setLngLat(target)
          } else {
            tweenMarker(entry.marker, [current.lng, current.lat], target)
          }
        }

        const el = entry.marker.getElement()
        const stateChanged = entry.state !== state
        const highlightChanged = entry.highlight !== highlight
        const numberChanged = entry.number !== (keke.keke_number ?? '')

        if (highlightChanged) {
          entry.highlight = highlight
          el.classList.toggle('km-keke-hi', highlight)
        }
        if (stateChanged) {
          entry.state = state
          el.classList.remove('km-keke-stale', 'km-keke-offline')
          if (state === 'stale') el.classList.add('km-keke-stale')
          else if (state === 'offline' || state === 'unavailable') {
            el.classList.add('km-keke-offline')
          }
        }

        // Refresh the popup when its words could have changed (state,
        // rider assignment, plate) or while it is open (age label ticks).
        const popup = entry.marker.getPopup()
        if (stateChanged || highlightChanged || numberChanged || popup?.isOpen?.()) {
          entry.number = keke.keke_number ?? ''
          popup.setHTML(kekePopupHTML(keke, state))
        }
      }
    }
    for (const [key, entry] of kekeMarkersRef.current) {
      if (!seenKekes.has(key)) {
        if (entry.marker._kmTween) cancelAnimationFrame(entry.marker._kmTween)
        entry.marker.remove()
        kekeMarkersRef.current.delete(key)
      }
    }
    scheduleCollisions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey, kekesKey, selectedId, failed, stateTick, retryKey])

  // Auto-fit the camera only when the SET of pins changes. Pin-less views
  // (before the admin saves coordinates) fall back to the campus camera once.
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed) return
    // Once the user grabs the map, they keep it — never yank the view back
    // (the Track-ride button re-frames explicitly through fitPoints).
    if (interactedRef.current) return
    const fitted = fitList([...points, ...kekes])
    if (fitted) {
      dataFitRef.current += 1
      return
    }
    if (!cameraAppliedRef.current) {
      getCampusCamera(supabase).then((camera) => {
        if (mapRef.current !== map || interactedRef.current) return
        // A pin-driven fit landed while this async fallback was resolving:
        // the data must win over the default campus camera.
        if (dataFitRef.current > 0) return
        cameraAppliedRef.current = true
        map.jumpTo({
          center: [camera.center.lng, camera.center.lat],
          zoom: camera.zoom,
        })
      }).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsIdsKey, kekesIdsKey, failed, retryKey])

  // The student's own position: blue dot + accuracy halo.
  // UPDATED IN PLACE: the marker is created once and moved with setLngLat,
  // the halo polygon with setData — never remove/re-add per GPS tick (that
  // DOM churn flickers the dot and stutters low-end Android, task 5).
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed || !styleReady) return

    const hasPos = validCoord(userLocation)

    if (!hasPos) {
      userMarkerRef.current?.remove()
      userMarkerRef.current = null
    } else if (!userMarkerRef.current) {
      const el = document.createElement('div')
      el.className = 'km-user'
      userMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
        .setLngLat([Number(userLocation.lng), Number(userLocation.lat)])
        .addTo(map)
    } else {
      userMarkerRef.current.setLngLat([Number(userLocation.lng), Number(userLocation.lat)])
    }

    // Accuracy halo. A style (re)load wipes sources/layers but NOT DOM
    // markers — getSource() returning nothing means "re-add", otherwise
    // just refresh the polygon when lng,lat,radius actually changed.
    const radius = Number(userAccuracy)
    const wantCircle = hasPos && Number.isFinite(radius) && radius > 0
    if (!wantCircle) {
      if (map.getLayer('user-accuracy')) map.removeLayer('user-accuracy')
      if (map.getSource('user-accuracy')) map.removeSource('user-accuracy')
      userCircleKeyRef.current = null
      return
    }

    const circleData = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [circlePolygon(Number(userLocation.lng), Number(userLocation.lat), Math.min(radius, 250))],
      },
    }
    const circleKey = `${Number(userLocation.lng).toFixed(6)},${Number(userLocation.lat).toFixed(6)},${Math.round(radius)}`

    if (map.getSource('user-accuracy')) {
      if (userCircleKeyRef.current !== circleKey) {
        map.getSource('user-accuracy').setData(circleData)
        userCircleKeyRef.current = circleKey
      }
      return
    }
    map.addSource('user-accuracy', { type: 'geojson', data: circleData })
    map.addLayer({
      id: 'user-accuracy',
      type: 'fill',
      source: 'user-accuracy',
      paint: { 'fill-color': '#0EA5E9', 'fill-opacity': 0.12 },
    })
    userCircleKeyRef.current = circleKey
  }, [userKey, failed, styleReady, styleEpoch, retryKey])

  // Manual pick-up pin (task 2): amber, draggable, set by tapping the map
  // or dragging. Rendered only when the parent passes one — the map stays a
  // controlled component and behaves exactly as before with none given.
  const pickupKey = JSON.stringify(manualPickup)
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed) return

    if (!validCoord(manualPickup)) {
      pickupMarkerRef.current?.remove()
      pickupMarkerRef.current = null
      return
    }

    const lngLat = [Number(manualPickup.lng), Number(manualPickup.lat)]
    if (!pickupMarkerRef.current) {
      const el = document.createElement('div')
      el.className = 'km-pickup'
      el.title = 'Manual pick-up point — drag to adjust'
      el.innerHTML = `${PICKUP_SVG}<span class="km-pickup-label">Pick-up</span>`
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom', draggable: true })
        .setLngLat(lngLat)
        .addTo(map)
      marker.on('dragend', () => {
        const pos = marker.getLngLat()
        suppressClickRef.current = Date.now()
        onManualPickupChangeRef.current?.({
          lat: Number(pos.lat.toFixed(6)),
          lng: Number(pos.lng.toFixed(6)),
        })
      })
      // A pin tap must not also drop a NEW pickup on the map underneath.
      marker.getElement().addEventListener('click', () => {
        suppressClickRef.current = Date.now()
      })
      pickupMarkerRef.current = marker
    } else {
      // Parent-driven move (e.g. "Use my GPS location"). While the key is
      // unchanged the effect does not re-run, so an in-progress drag is
      // never fought.
      pickupMarkerRef.current.setLngLat(lngLat)
    }
  }, [pickupKey, failed, retryKey])

  // Pause keke tweens when the tab hides (task 4): rAF stops firing in a
  // hidden tab, so on resume a time-based tween would jump-cut to its end.
  // Snap every in-flight tween to its REAL target instead — no fabricated
  // motion, no catch-up jump.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return
      for (const entry of kekeMarkersRef.current.values()) {
        const marker = entry.marker
        if (marker._kmTween) {
          cancelAnimationFrame(marker._kmTween)
          marker._kmTween = null
        }
        if (marker._kmTweenTo) {
          marker.setLngLat(marker._kmTweenTo)
          marker._kmTweenTo = null
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Danfolio's locally maintained campus vectors. These overlay the
  // general basemap and become the campus-specific source of truth as the
  // road/building survey is digitised. Empty starter GeoJSON files are valid.
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed || !styleReady) return
    let cancelled = false

    Promise.all([
      loadCampusGeoJSON(CAMPUS_VECTOR_FILES.roads),
      loadCampusGeoJSON(CAMPUS_VECTOR_FILES.footpaths),
      loadCampusGeoJSON(CAMPUS_VECTOR_FILES.buildings),
    ]).then(([roads, footpaths, buildings]) => {
      if (cancelled || mapRef.current !== map) return

      // The effect only runs after style.load (styleReady/styleEpoch), so
      // the style normally accepts writes immediately. If a style swap is
      // mid-flight, addSource/addLayer throw — retry briefly instead of
      // gating on isStyleLoaded(), which waits for EVERY viewport tile and
      // would silently drop our layers on a slow network. The next
      // style.load bumps the epoch and re-runs this effect either way.
      const addVectors = (attempt = 0) => {
        if (cancelled || mapRef.current !== map) return
        try {
          addCampusVectorLayers(map, { roads, footpaths, buildings })
        } catch (error) {
          if (attempt >= 40) {
            // A vector-layer failure must never take down the navigation map.
            // eslint-disable-next-line no-console
            console.warn('Campus vector layers not added:', error)
            return
          }
          window.setTimeout(() => addVectors(attempt + 1), 50)
        }
      }
      addVectors()
    })

    return () => { cancelled = true }
  }, [failed, styleReady, styleEpoch])

  // Route line via the configured routing provider. Real road path when the
  // provider answers; dashed, clearly-labelled direct line otherwise (with
  // NO ETA, so an estimate is never fabricated).
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed || !styleReady) return

    const sourceId = 'campus-route'
    const from = route?.from
    const to = route?.to

    const removeRoute = () => {
      // On unmount the map-init cleanup (declared earlier) runs FIRST and
      // has already called map.remove(), which deletes map.style. Never let
      // a style-less map throw during teardown — React would unmount the
      // ENTIRE app (blank page) on any navigation away from this page.
      if (map.style) {
        if (map.getLayer(sourceId)) map.removeLayer(sourceId)
        if (map.getLayer(`${sourceId}-casing`)) map.removeLayer(`${sourceId}-casing`)
        if (map.getSource(sourceId)) map.removeSource(sourceId)
      }
      if (routeAnimRef.current) {
        cancelAnimationFrame(routeAnimRef.current)
        routeAnimRef.current = null
      }
      routeModeRef.current = null
      setRouteNote('')
    }

    if (!validCoord(from) || !validCoord(to)) {
      removeRoute()
      onRouteInfoRef.current?.(null)
      return
    }

    const direct = [
      [Number(from.lng), Number(from.lat)],
      [Number(to.lng), Number(to.lat)],
    ]

    // Draw-on animation for a journey that was just selected (task 3):
    // the line reveals head-to-tail over ~700 ms, ONLY while a route is
    // being drawn — idle (no route) animates nothing — and
    // prefers-reduced-motion skips straight to the full line. The final
    // frame is always the complete, unmodified route geometry.
    const revealRoute = (line) => {
      if (routeAnimRef.current) {
        cancelAnimationFrame(routeAnimRef.current)
        routeAnimRef.current = null
      }
      let reduced = false
      try {
        reduced = Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
      } catch {
        reduced = false
      }
      if (reduced) return
      const full = subdivideStraight(line)
      if (full.length < 3) return

      const paint = (count) => {
        const src = map.getSource(sourceId)
        if (!src) return false
        src.setData({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: full.slice(0, count) },
          properties: {},
        })
        return true
      }

      const total = full.length
      const DURATION = 700
      const start = performance.now()
      if (!paint(2)) return
      const step = (t) => {
        if (mapRef.current !== map || !map.getSource(sourceId)) {
          routeAnimRef.current = null
          return
        }
        const p = Math.min(1, (t - start) / DURATION)
        const eased = 1 - (1 - p) ** 3
        const count = Math.max(2, Math.ceil(total * eased))
        paint(count)
        if (p < 1) {
          routeAnimRef.current = requestAnimationFrame(step)
        } else {
          routeAnimRef.current = null
        }
      }
      routeAnimRef.current = requestAnimationFrame(step)
    }

    // The layer is rebuilt when the mode flips (road ↔ direct) so paint
    // properties are always created correct; otherwise just swap coordinates.
    const drawRoute = (line, fallback) => {
      const mode = fallback ? 'direct' : 'road'
      const data = {
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: line },
        properties: {},
      }

      if (map.getSource(sourceId) && routeModeRef.current !== mode) {
        map.removeLayer(sourceId)
        if (map.getLayer(`${sourceId}-casing`)) map.removeLayer(`${sourceId}-casing`)
        map.removeSource(sourceId)
      }

      if (map.getSource(sourceId)) {
        map.getSource(sourceId).setData(data)
      } else {
        map.addSource(sourceId, { type: 'geojson', data })
        map.addLayer({
          id: `${sourceId}-casing`,
          type: 'line',
          source: sourceId,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': '#FFFFFF',
            'line-width': fallback ? 7 : 9,
            'line-opacity': 0.95,
            ...(fallback ? { 'line-dasharray': [1.5, 1.5] } : {}),
          },
        })
        map.addLayer({
          id: sourceId,
          type: 'line',
          source: sourceId,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': fallback ? '#64748B' : '#2563EB',
            'line-width': 5,
            'line-opacity': fallback ? 0.7 : 0.85,
            ...(fallback ? { 'line-dasharray': [1.5, 1.5] } : {}),
          },
        })
      }
      routeModeRef.current = mode
      setRouteNote(fallback ? ROUTE_FALLBACK_NOTE : '')
      // Journey selected → draw it on (no-op when reduced-motion is set).
      revealRoute(line)
    }

    // Local campus road graph first (it knows the imported roads — the
    // remote OSRM server does not), then the configured OSRM provider,
    // then a clearly-labelled direct line (never presented as a road route).
    let cancelled = false

    routeCampusTrip(from, to)
      .then((result) => {
        if (cancelled) return
        if (result && !result.fallback) {
          drawRoute(result.coordinates, false)
          onRouteInfoRef.current?.({
            seconds: result.seconds,
            meters: result.meters,
            fallback: false,
          })
        } else {
          drawRoute(direct, true)
          onRouteInfoRef.current?.(null)
        }
      })
      .catch(() => {
        if (cancelled) return
        drawRoute(direct, true)
        onRouteInfoRef.current?.(null)
      })

    return () => {
      cancelled = true
      removeRoute()
      onRouteInfoRef.current?.(null)
    }
  }, [JSON.stringify(route), failed, styleReady, styleEpoch, retryKey])

  if (failed) {
    return (
      <div
        className="card muted bk-map-failed"
        style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
      >
        <div>
          <p>The map could not be loaded. Check your connection — everything else on this screen still works.</p>
          <button type="button" className="secondary" onClick={retryMap}>Try again</button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height }}>
      <div
        ref={containerRef}
        className="campus-map"
        style={{ height, borderRadius: 16, overflow: 'hidden' }}
      />
      {/* Honest GPS status (task 1): only rendered when the parent passes
          its useGeolocation state — never invents a state of its own, and
          never shows a position it does not have. */}
      {(() => {
        const blocked =
          !validCoord(userLocation) && locationState && GPS_STATUS_MESSAGES[locationState]
            ? locationState
            : null
        if (!blocked) return null
        return (
          <div className="km-gps-status" role="status">
            <span>{GPS_STATUS_MESSAGES[blocked]}</span>
            {blocked !== 'insecure' && onLocationRetry && (
              <button type="button" onClick={() => onLocationRetry?.()}>Retry</button>
            )}
          </div>
        )
      })()}
      {/* Task 2: swap the manual pin back to the real GPS position. */}
      {validCoord(userLocation) &&
        validCoord(manualPickup) &&
        (onUseGps || onManualPickupChange) && (
          <button
            type="button"
            className="km-usegps"
            onClick={() => {
              if (onUseGps) onUseGps(userLocation)
              else onManualPickupChange?.(userLocation)
            }}
          >
            Use my GPS location
          </button>
        )}
      {routeNote && (
        <div className="muted km-route-note" style={{ fontSize: 12, marginTop: 4 }}>{routeNote}</div>
      )}
      {basemapWarning && (
        <div className="km-map-warning" role="status" aria-live="polite">
          <span>{basemapWarning}</span>
          <button type="button" onClick={retryMap}>Retry map</button>
        </div>
      )}
    </div>
  )
})

export { resetCampusCameraCache }
export default CampusMap
