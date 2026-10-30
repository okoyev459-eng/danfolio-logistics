import { useCallback, useEffect, useRef, useState } from 'react'

// useGeolocation — the device's current position with honest permission
// states, so the booking map can say "locating…", "location blocked" or
// "location unavailable" instead of silently showing nothing.
//
// state: 'idle' | 'asking' | 'granted' | 'denied' | 'unavailable' | 'timeout'
// position: { lat, lng } | null
// accuracy: metres | null

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
        if (err?.code === err?.PERMISSION_DENIED) setState('denied')
        else if (err?.code === err?.TIMEOUT) setState('timeout')
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
