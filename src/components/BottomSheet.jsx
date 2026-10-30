import { useCallback, useEffect, useRef, useState } from 'react'
import { nearestSnap } from '../lib/geo'
import './BottomSheet.css'

// BottomSheet — the Bolt-style draggable sheet over the booking map.
//
// Pure React + pointer events (no extra dependency). The parent OWNS the
// snap index; the sheet reports releases via onIndexChange.
//
//   snaps   visible heights in *visibility order*: index 0 = collapsed peek,
//           last = fully expanded. Values < 1 are fractions of the parent
//           height; values >= 1 are pixels (e.g. [152, 0.46, 0.88]).
//   header  the draggable area (grab handle + title row). Drag only starts
//           here, so the body scrolls naturally on touch devices.
//
// Gestures: drag anywhere on the header with velocity-aware flick; a tap
// (no drag) on the header toggles peek <-> mid.

export default function BottomSheet({
  snaps = [152, 0.46, 0.88],
  index = 0,
  onIndexChange,
  header,
  children,
  ariaLabel = 'Details',
}) {
  const sheetRef = useRef(null)
  const snapsRef = useRef(snaps)
  snapsRef.current = snaps
  const indexRef = useRef(index)
  indexRef.current = index

  const [translateY, setTranslateY] = useState(null) // null until measured
  const [dragging, setDragging] = useState(false)
  const [dims, setDims] = useState({ fullPx: 0, tSnaps: [] })

  const dragRef = useRef(null)

  // Measure on mount and on resize: sheet height = fully expanded snap;
  // each snap becomes a translateY offset (full visible = 0, peek = largest).
  useEffect(() => {
    function measure() {
      const el = sheetRef.current
      if (!el) return
      const parentH = el.parentElement?.clientHeight || window.innerHeight
      const last = snapsRef.current[snapsRef.current.length - 1]
      const fullH = last < 1 ? Math.round(last * parentH) : last
      const tSnaps = snapsRef.current.map((s) =>
        fullH - (s < 1 ? Math.round(s * parentH) : s),
      )
      setDims({ fullPx: fullH, tSnaps })
      setTranslateY(tSnaps[Math.min(indexRef.current, tSnaps.length - 1)] ?? 0)
    }

    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  // Follow external index changes (programmatic snaps animate via CSS).
  useEffect(() => {
    if (!dims.tSnaps.length) return
    setTranslateY(dims.tSnaps[Math.min(index, dims.tSnaps.length - 1)] ?? 0)
  }, [index, dims])

  const settle = useCallback(
    (nextIndex) => {
      const t = dims.tSnaps[nextIndex]
      if (t !== undefined) setTranslateY(t)
      if (nextIndex !== indexRef.current) onIndexChange?.(nextIndex)
    },
    [dims, onIndexChange],
  )

  function pointerDown(e) {
    if (!dims.tSnaps.length || translateY === null) return
    e.currentTarget.setPointerCapture?.(e.pointerId)
    dragRef.current = {
      startY: e.clientY,
      startT: translateY,
      lastY: e.clientY,
      lastTime: performance.now(),
      velocity: 0,
      moved: 0,
    }
    setDragging(true)
  }

  function pointerMove(e) {
    const d = dragRef.current
    if (!d) return
    const dy = e.clientY - d.startY
    d.moved = Math.max(d.moved, Math.abs(dy))
    const now = performance.now()
    const dt = now - d.lastTime
    if (dt > 0) d.velocity = (e.clientY - d.lastY) / dt
    d.lastY = e.clientY
    d.lastTime = now

    const min = Math.min(...dims.tSnaps) // fully visible
    const max = Math.max(...dims.tSnaps) // peek
    let raw = d.startT + dy
    // Rubber-band beyond the extremes so it feels physical.
    if (raw < min) raw = min + (raw - min) * 0.25
    if (raw > max) raw = max + (raw - max) * 0.25
    setTranslateY(raw)
  }

  function pointerUp(e) {
    const d = dragRef.current
    dragRef.current = null
    setDragging(false)
    if (!d) return

    if (d.moved < 6 && Math.abs(d.velocity) < 0.2) {
      // A tap on the header toggles the sheet.
      settle(indexRef.current === 0 ? 1 : 0)
      return
    }

    const raw = d.startT + (e.clientY - d.startY)
    settle(nearestSnap(raw, dims.tSnaps, d.velocity))
  }

  return (
    <div
      ref={sheetRef}
      className={'bs' + (dragging ? ' bs-dragging' : '')}
      style={{
        height: dims.fullPx || undefined,
        transform: translateY === null ? undefined : `translateY(${translateY}px)`,
        transition: dragging ? 'none' : undefined,
      }}
      role="region"
      aria-label={ariaLabel}
    >
      <header
        className="bs-header"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
      >
        <div className="bs-handle" aria-hidden="true" />
        {header}
      </header>
      <div className="bs-body">{children}</div>
    </div>
  )
}
