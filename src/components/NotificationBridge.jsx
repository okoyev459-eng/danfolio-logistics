import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/auth.jsx'
import { supabase } from '../lib/supabase'
import {
  disablePush,
  enablePush,
  pushPermission,
  pushSupported,
  syncPushSubscription,
} from '../lib/push'
import './notification-bridge.css'

// NotificationBridge — the frontend glue, mounted once in App.jsx.
//
// Three jobs, all additive (nothing here changes ride/payment behaviour):
//
//   1. Silent re-sync: on every login, if notification permission was
//      already granted, make sure `push_subscriptions` holds the current
//      browser subscription (browsers rotate endpoints between visits).
//
//   2. In-app toasts: subscribes to Realtime INSERTs on `notifications`
//      for the signed-in user and shows each one as a transient toast.
//      The toast is FOREGROUND feedback only — it never fires a system
//      notification, so the service worker (push) remains the single
//      source of system alerts and nothing double-pops.
//
//   3. Opt-in banner: a dismissible "Enable notifications" pill shown
//      once while permission is still 'default'. Permission is only ever
//      requested from the explicit Enable tap (browsers block unprompted
//      requests). Denied permission hides it permanently — the in-app
//      UI keeps working regardless.
//
// Degradation: no session → renders nothing; unsupported browser →
// renders nothing; realtime failure → toasts silently absent.

const DISMISS_KEY = 'danfolio-push-optin-dismissed'
const DENIED_KEY = 'danfolio-push-optin-denied'

function isDismissed(key) {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return true // storage blocked → don't nag
  }
}

function dismiss(key) {
  try {
    localStorage.setItem(key, '1')
  } catch {
    /* nothing to persist to */
  }
}

export default function NotificationBridge() {
  const { session } = useAuth()
  const [toasts, setToasts] = useState([])
  const [banner, setBanner] = useState(false)
  const [optInBusy, setOptInBusy] = useState(false)
  const toastSeq = useRef(0)

  // 1. Silent re-sync on login.
  useEffect(() => {
    if (!session) return
    syncPushSubscription()
  }, [session])

  // 3. Opt-in banner state (only while permission is genuinely askable).
  useEffect(() => {
    if (!session || !pushSupported()) {
      setBanner(false)
      return
    }
    const permission = pushPermission()
    if (permission === 'granted') {
      setBanner(false)
      return
    }
    if (permission === 'denied') {
      dismiss(DENIED_KEY)
      setBanner(false)
      return
    }
    setBanner(
      !isDismissed(DENIED_KEY) && !isDismissed(DISMISS_KEY),
    )
  }, [session])

  // 2. Realtime in-app toasts.
  useEffect(() => {
    if (!session) return undefined
    let alive = true

    const channel = supabase
      .channel(`notifications:${session.user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${session.user.id}`,
        },
        (payload) => {
          if (!alive) return
          const row = payload.new
          if (!row?.title) return
          const id = (toastSeq.current += 1)
          setToasts((prev) => [
            ...prev.slice(-2), // at most 3 on screen; oldest drops
            { id, title: row.title, body: row.body, type: row.type },
          ])
          window.setTimeout(() => {
            setToasts((prev) => prev.filter((t) => t.id !== id))
          }, 6000)
        },
      )
      .subscribe()

    return () => {
      alive = false
      supabase.removeChannel(channel)
    }
  }, [session])

  async function handleEnable() {
    setOptInBusy(true)
    try {
      const status = await enablePush()
      if (status === 'denied') dismiss(DENIED_KEY)
      setBanner(false) // any terminal outcome hides the pill
    } finally {
      setOptInBusy(false)
    }
  }

  function handleDismiss() {
    dismiss(DISMISS_KEY)
    setBanner(false)
  }

  async function handleTurnOff() {
    await disablePush()
    setBanner(false)
  }

  if (!session) return null

  const permission = pushPermission()
  const showBanner =
    banner && pushSupported() && permission === 'default' && !optInBusy

  return (
    <>
      {/* Foreground toasts — visual only, never system notifications. */}
      <div className="notify-toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`notify-toast notify-toast-${t.type}`}>
            <b>{t.title}</b>
            {t.body ? <span>{t.body}</span> : null}
          </div>
        ))}
      </div>

      {/* Opt-in pill */}
      {showBanner ? (
        <div className="notify-optin" role="region" aria-label="Notifications">
          <span>Get ride alerts even when the app is closed.</span>
          <div className="notify-optin-actions">
            <button type="button" onClick={handleEnable} disabled={optInBusy}>
              {optInBusy ? 'Enabling…' : 'Enable'}
            </button>
            <button type="button" className="ghost" onClick={handleDismiss}>
              Not now
            </button>
          </div>
        </div>
      ) : null}

      {/* Already granted → tiny control to turn push off again. */}
      {permission === 'granted' ? (
        <button
          type="button"
          className="notify-toggle"
          onClick={handleTurnOff}
          title="Turn off push notifications"
        >
          Notifications on · turn off
        </button>
      ) : null}
    </>
  )
}
