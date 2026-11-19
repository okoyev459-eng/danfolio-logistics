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
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (!aliveRef.current) return
        setPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude })
        setAccuracy(Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null)
        setState('granted')
      },
      (err) => {
        if (!aliveRef.current) return
        if (err?.code === err?.PERMISSION_DENIED) {
          setState(insecureContext() ? 'insecure' : 'denied')
        } else if (err?.code === err?.TIMEOUT) setState('timeout')
        else setState('unavailable')
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 },
    )
  }, [])

  useEffect(() => {
    if (auto) request()
  }, [auto, request])

  return { state, position, accuracy, request }
}
