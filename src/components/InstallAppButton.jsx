import { useEffect, useState } from 'react'
import {
  isIosInstallDevice,
  isStandaloneDisplay,
} from '../lib/uiRules.js'

function readStandalone() {
  if (typeof window === 'undefined') return false
  return isStandaloneDisplay({
    standalone: window.navigator.standalone,
    displayMode: window.matchMedia?.('(display-mode: standalone)').matches
      ? 'standalone'
      : '',
  })
}

export default function InstallAppButton({ className = '' }) {
  const [deferred, setDeferred] = useState(null)
  const [installed, setInstalled] = useState(readStandalone)
  const [iosHint, setIosHint] = useState(false)

  useEffect(() => {
    if (installed) return undefined

    const onBeforeInstall = (e) => {
      e.preventDefault()
      setDeferred(e)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
      setIosHint(false)
    }
    const mql = window.matchMedia?.('(display-mode: standalone)')
    const onDisplayMode = () => {
      if (readStandalone()) onInstalled()
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)
    mql?.addEventListener?.('change', onDisplayMode)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      mql?.removeEventListener?.('change', onDisplayMode)
    }
  }, [installed])

  if (installed) return null

  const ios = isIosInstallDevice({
    userAgent: window.navigator.userAgent,
    platform: window.navigator.platform,
    maxTouchPoints: window.navigator.maxTouchPoints,
  })

  if (!deferred && !ios) return null

  async function handleClick() {
    if (deferred) {
      deferred.prompt()
      try {
        const choice = await deferred.userChoice
        if (choice?.outcome === 'accepted') setInstalled(true)
      } catch {
        // Ignore prompt failures; button can be tried again.
      }
      setDeferred(null)
      return
    }
    setIosHint((v) => !v)
  }

  return (
    <div className={`install-app ${className}`.trim()}>
      <button
        type="button"
        className="install-app-btn secondary"
        onClick={handleClick}
        aria-expanded={ios && !deferred ? iosHint : undefined}
      >
        Install app
      </button>
      {iosHint && !deferred && (
        <p className="install-app-hint" role="status">
          On iPhone/iPad: tap Share, then <b>Add to Home Screen</b>.
        </p>
      )}
    </div>
  )
}
