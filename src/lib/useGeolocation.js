import { useCallback, useEffect, useRef, useState } from 'react'

// useGeolocation — the device's current position with honest permission
// states, so the booking map can say "locating…", "location blocked" or
// "location unavailable" instead of silently showing nothing.
//
// state: 'idle' | 'asking' | 'granted' | 'denied' | 'insecure' | 'unavailable' | 'timeout'
// position: { lat, lng } | null
// accuracy: metres | null

// Browsers only expose the Geolocation API on secure contexts. Opened over
// plain http:// (e.g. the dev server via a LAN IP: http://192.168.x.x:5173)
// every request fails with PERMISSION_DENIED and NO prompt is ever shown —
// so telling the user to "allow location" would be a lie only the laptop
// (localhost is exempt) never sees. This is the honest state for it.
export function insecureContext() {
  return typeof window !== 'undefined' && window.isSecureContext === false
}

export function useGeolocation({ auto = true } = {}) {
  const [state, setState] = useState('idle')
  const [position, setPosition] = useState(null)
  const [accuracy, setAccuracy] = useState(null)
  // True when the only fix the browser could give us came from its cache
  // (a slow/blocked GPS). Callers may label it "approximate"; the distance
  // labels stay honest either way.
  const [cached, setCached] = useState(false)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const request = useCallback(() => {
    if (!navigator.geolocation) {
      setState('unavailable')
      return
    }
    // Fail fast with the real reason: on an insecure origin the browser
    // denies without ever prompting, so "asking" would be theatre.
    if (insecureContext()) {
      setState('insecure')
      return
    }
    setState('asking')
    setCached(false)

    const apply = (pos, fromCache) => {
      if (!aliveRef.current) return
      setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude })
      setAccuracy(Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null)
      setCached(Boolean(fromCache))
      setState('granted')
    }

    // First attempt: a REAL, current fix only (maximumAge 0). The old 15 s
    // cache window meant a student who had just walked across campus could be
    // shown a position from where they had been standing.
    navigator.geolocation.getCurrentPosition(
      (pos) => apply(pos, false),
      (err) => {
        if (!aliveRef.current) return
        if (err?.code === err?.PERMISSION_DENIED) {
          setState(insecureContext() ? 'insecure' : 'denied')
          return
        }
        // TIMEOUT / POSITION_UNAVAILABLE: the GPS is slow or shielded (common
        // under a lecture-theatre roof). Fall back ONCE to a cached fix so the
        // student still gets a usable map, flagged as approximate.
        navigator.geolocation.getCurrentPosition(
          (pos) => apply(pos, true),
          (retryErr) => {
            if (!aliveRef.current) return
            if (retryErr?.code === retryErr?.PERMISSION_DENIED) {
              setState(insecureContext() ? 'insecure' : 'denied')
            } else if (retryErr?.code === retryErr?.TIMEOUT) setState('timeout')
            else setState('unavailable')
          },
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 },
        )
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    )
  }, [])

  useEffect(() => {
    if (auto) request()
  }, [auto, request])

  return { state, position, accuracy, cached, request }
}
