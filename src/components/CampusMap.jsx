import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { circlePolygon, validCoord } from '../lib/geo'

// CampusMap — the app's only map renderer.
//
// Free stack only (no billing account, no API key):
//   - MapLibre GL JS   rendering (BSD-3-Clause, in package.json)
//   - OpenFreeMap       map tiles + style (https://openfreemap.org, no key)
//   - OpenStreetMap     underlying map data (© OpenStreetMap contributors)
//
// Routing and address search are deliberately separate concerns:
//   - Routing: optional, via the public OSRM demo server, drawn as a line
//     between two points. It can be rate-limited or unavailable; the map
//     falls back to a straight line and says so in the UI.
//   - Address search: NOT provided. Students choose from the admin's fixed
//     location lists (spec section 1), which is the product requirement.
//
// Markers:
//   - location pins are colour-coded by kind (pickup/station/destination);
//     the `selectedId` pin gets a highlight ring;
//   - keke riders render as distinct vehicle badges (red = nearby, green +
//     pulsing = your assigned rider via `highlight`);
//   - the student's own position renders as a blue dot with an accuracy halo.
//
// Camera: the view auto-fits when the SET of pins changes (ids), not on
// every live position tick, so a moving keke never yanks the camera.
// Parents can also drive the camera imperatively via the ref API:
//   { zoomIn, zoomOut, recenter, fitPoints(points) }
//
// Attribution: MapLibre's AttributionControl is added explicitly and cannot
// be disabled here — OSM/OpenFreeMap terms require it.

const CAMPUS_CENTER = [4.5226, 8.4799] // Unilorin area; overridden by markers
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving'

const KIND_COLORS = {
  pickup: '#2563EB',
  station: '#1E3A8A',
  destination: '#7C3AED',
}

const KEKE_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5 11l1.5-4.2A2 2 0 0 1 8.4 5.5h7.2a2 2 0 0 1 1.9 1.3L19 11M5 11h14M5 11a2 2 0 0 0-2 2v3.5h2M19 11a2 2 0 0 1 2 2v3.5h-2M5 16.5V19m14-2.5V19M7.5 14h.5m8 0h.5"/></svg>'

function makeKekeElement(highlight) {
  const el = document.createElement('div')
  el.className = 'km-keke' + (highlight ? ' km-keke-hi' : '')
  el.innerHTML = KEKE_SVG
  return el
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
    selectedId = null,
    animate = false,
    navControls = true,
    onReady = null,
    onFail = null,
  },
  ref,
) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const userMarkerRef = useRef(null)
  const [failed, setFailed] = useState(false)
  const [routeNote, setRouteNote] = useState('')

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
      map.fitBounds(bounds, {
        padding: 60,
        maxZoom: 16,
        duration: animate ? 900 : 0,
      })
    }
    return ok
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
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: CAMPUS_CENTER,
        zoom: 14,
        attributionControl: false,
        interactive,
      })
    } catch {
      setFailed(true)
      onFailRef.current?.()
      return
    }

    mapRef.current = map
    map.addControl(new maplibregl.AttributionControl({ compact: true }))
    if (interactive && navControls) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    }

    map.on('error', (event) => {
      // Tile/style load errors are non-fatal (a marker-less map still shows);
      // a total style failure is handled by the timeout check below.
      if (event?.error?.message?.includes?.('style')) {
        setFailed(true)
        onFailRef.current?.()
      }
    })

    map.once('load', () => onReadyRef.current?.())

    // If the style never becomes loadable within 10s (blocked network, DNS),
    // tell the user instead of showing a blank box.
    const timer = window.setTimeout(() => {
      if (!map.isStyleLoaded()) {
        setFailed(true)
        onFailRef.current?.()
      }
    }, 10000)

    return () => {
      window.clearTimeout(timer)
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      userMarkerRef.current?.remove()
      userMarkerRef.current = null
      map.remove()
      mapRef.current = null
    }
  }, [interactive, navControls, failed])

  // Sync location + keke markers with props (rebuild only, no camera move).
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed) return

    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    for (const point of points) {
      if (!validCoord(point)) continue

      const color = KIND_COLORS[point.kind] ?? '#2563EB'
      const marker = new maplibregl.Marker({ color })
        .setLngLat([Number(point.lng), Number(point.lat)])
        .setPopup(new maplibregl.Popup().setHTML(`<b>${point.name ?? 'Point'}</b>`))
        .addTo(map)

      if (selectedId && (point.id ?? point.name) === selectedId) {
        marker.getElement().classList.add('km-point-sel')
      }

      if (onSelectRef.current) {
        marker.getElement().addEventListener('click', () => onSelectRef.current?.(point))
      }

      markersRef.current.push(marker)
    }

    for (const keke of kekes) {
      if (!validCoord(keke)) continue

      const marker = new maplibregl.Marker({
        element: makeKekeElement(Boolean(keke.highlight)),
        anchor: 'center',
      })
        .setLngLat([Number(keke.lng), Number(keke.lat)])
        .setPopup(
          new maplibregl.Popup().setHTML(
            `<b>Keke ${keke.keke_number ?? ''}</b>${keke.highlight ? ' · your rider' : ''}`,
          ),
        )
        .addTo(map)

      markersRef.current.push(marker)
    }
  }, [pointsKey, kekesKey, selectedId, failed])

  // Auto-fit the camera only when the SET of pins changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed) return
    fitList([...points, ...kekes])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsIdsKey, kekesIdsKey, failed])

  // The student's own position: blue dot + accuracy halo.
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed) return

    userMarkerRef.current?.remove()
    userMarkerRef.current = null
    if (map.getLayer('user-accuracy')) map.removeLayer('user-accuracy')
    if (map.getSource('user-accuracy')) map.removeSource('user-accuracy')

    if (!validCoord(userLocation)) return

    const el = document.createElement('div')
    el.className = 'km-user'
    userMarkerRef.current = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([Number(userLocation.lng), Number(userLocation.lat)])
      .addTo(map)

    const radius = Number(userAccuracy)
    if (Number.isFinite(radius) && radius > 0) {
      map.addSource('user-accuracy', {
        type: 'geojson',
        data: {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [circlePolygon(Number(userLocation.lng), Number(userLocation.lat), Math.min(radius, 250))],
          },
        },
      })
      map.addLayer({
        id: 'user-accuracy',
        type: 'fill',
        source: 'user-accuracy',
        paint: { 'fill-color': '#2563EB', 'fill-opacity': 0.12 },
      })
    }
  }, [userKey, failed])

  // Optional route line (OSRM demo server, with straight-line fallback).
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed) return

    const sourceId = 'campus-route'
    const from = route?.from
    const to = route?.to

    const removeRoute = () => {
      if (map.getLayer(sourceId)) map.removeLayer(sourceId)
      if (map.getSource(sourceId)) map.removeSource(sourceId)
      setRouteNote('')
    }

    if (!validCoord(from) || !validCoord(to)) {
      removeRoute()
      onRouteInfoRef.current?.(null)
      return
    }

    const coordinates = [
      [Number(from.lng), Number(from.lat)],
      [Number(to.lng), Number(to.lat)],
    ]

    const drawRoute = (line, note) => {
      if (map.getSource(sourceId)) {
        map.getSource(sourceId).setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} })
      } else {
        map.addSource(sourceId, {
          type: 'geojson',
          data: { type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} },
        })
        map.addLayer({
          id: sourceId,
          type: 'line',
          source: sourceId,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#2563EB', 'line-width': 4, 'line-opacity': 0.8 },
        })
      }
      setRouteNote(note)
    }

    // Ask OSRM for a real path; fall back to a straight line on any failure.
    let cancelled = false
    const url =
      `${OSRM_URL}/${coordinates[0][0]},${coordinates[0][1]};` +
      `${coordinates[1][0]},${coordinates[1][1]}?overview=full&geometries=geojson`

    fetch(url, { signal: AbortSignal.timeout(6000) })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('osrm unavailable'))))
      .then((data) => {
        if (cancelled) return
        const first = data?.routes?.[0]
        const line = first?.geometry?.coordinates
        if (!Array.isArray(line) || line.length < 2) throw new Error('no route')
        drawRoute(line, '')
        // ETA (spec C5): OSRM reports the route duration in seconds.
        if (Number.isFinite(first?.duration)) {
          onRouteInfoRef.current?.({ seconds: Math.round(first.duration) })
        }
      })
      .catch(() => {
        if (cancelled) return
        drawRoute(coordinates, 'Live route unavailable — showing the direct path.')
        onRouteInfoRef.current?.(null)
      })

    return () => {
      cancelled = true
      removeRoute()
      onRouteInfoRef.current?.(null)
    }
  }, [JSON.stringify(route), failed])

  if (failed) {
    return (
      <div
        className="card muted bk-map-failed"
        style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
      >
        The map could not be loaded. Check your connection — everything else on
        this screen still works.
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
      {routeNote && (
        <div className="muted km-route-note" style={{ fontSize: 12, marginTop: 4 }}>{routeNote}</div>
      )}
    </div>
  )
})

export default CampusMap
