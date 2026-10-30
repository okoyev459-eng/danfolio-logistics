import { useEffect, useRef, useState } from 'react'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { validCoord } from '../lib/geo'

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
// Attribution: MapLibre's AttributionControl is added explicitly and cannot
// be disabled here — OSM/OpenFreeMap terms require it.

const CAMPUS_CENTER = [4.5226, 8.4799] // Unilorin area; overridden by markers
const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving'

const KIND_COLORS = {
  pickup: '#2563EB',
  station: '#1E3A8A',
  destination: '#7C3AED',
}

export default function CampusMap({
  points = [],
  kekes = [],
  route = null,
  height = 260,
  interactive = true,
  onSelect = null,
  onRouteInfo = null,
}) {
  const containerRef = useRef(null)
  const mapRef = useRef(null)
  const markersRef = useRef([])
  const [failed, setFailed] = useState(false)
  const [routeNote, setRouteNote] = useState('')

  // Keep the latest callback in a ref so route effects never re-run just
  // because the parent re-created the function.
  const onRouteInfoRef = useRef(onRouteInfo)
  onRouteInfoRef.current = onRouteInfo

  const pointsKey = JSON.stringify(points)
  const kekesKey = JSON.stringify(kekes)

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
      return
    }

    mapRef.current = map
    map.addControl(new maplibregl.AttributionControl({ compact: true }))
    if (interactive) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    }

    map.on('error', (event) => {
      // Tile/style load errors are non-fatal (a marker-less map still shows);
      // a total style failure is handled by the 'idle'/timeout check below.
      if (event?.error?.message?.includes('style')) setFailed(true)
    })

    // If the style never becomes loadable within 10s (blocked network, DNS),
    // tell the user instead of showing a blank box.
    const timer = window.setTimeout(() => {
      if (!map.isStyleLoaded()) setFailed(true)
    }, 10000)

    return () => {
      window.clearTimeout(timer)
      markersRef.current.forEach((m) => m.remove())
      markersRef.current = []
      map.remove()
      mapRef.current = null
    }
  }, [interactive, failed])

  // Sync location markers with props.
  useEffect(() => {
    const map = mapRef.current
    if (!map || failed) return

    markersRef.current.forEach((m) => m.remove())
    markersRef.current = []

    const bounds = new maplibregl.LngLatBounds()
    let fitted = false

    for (const point of points) {
      if (!validCoord(point)) continue

      const color = KIND_COLORS[point.kind] ?? '#2563EB'
      const marker = new maplibregl.Marker({ color })
        .setLngLat([Number(point.lng), Number(point.lat)])
        .setPopup(new maplibregl.Popup().setHTML(`<b>${point.name ?? 'Point'}</b>`))
        .addTo(map)

      if (onSelect) {
        marker.getElement().addEventListener('click', () => onSelect(point))
      }

      markersRef.current.push(marker)
      bounds.extend([Number(point.lng), Number(point.lat)])
      fitted = true
    }

    for (const keke of kekes) {
      if (!validCoord(keke)) continue

      const marker = new maplibregl.Marker({ color: '#DC2626' })
        .setLngLat([Number(keke.lng), Number(keke.lat)])
        .setPopup(new maplibregl.Popup().setHTML(`<b>Keke ${keke.keke_number ?? ''}</b>`))
        .addTo(map)

      markersRef.current.push(marker)
      bounds.extend([Number(keke.lng), Number(keke.lat)])
      fitted = true
    }

    if (fitted) {
      map.fitBounds(bounds, { padding: 40, maxZoom: 16, duration: 0 })
    }
  }, [pointsKey, kekesKey, failed, onSelect])

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
        className="card muted"
        style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
      >
        The map could not be loaded. Check your connection — everything else on
        this screen still works.
      </div>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <div
        ref={containerRef}
        className="campus-map"
        style={{ height, borderRadius: 16, overflow: 'hidden' }}
      />
      {routeNote && (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>{routeNote}</div>
      )}
    </div>
  )
}
