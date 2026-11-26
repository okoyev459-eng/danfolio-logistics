import { useEffect, useState } from 'react'
import './ResendLink.css'
import { emailErrorMessage, isRateLimitError } from '../lib/emailErrors.js'
import {
  RATE_LIMIT_COOLDOWN_SECONDS,
  RESEND_COOLDOWN_SECONDS,
  cooldownKey,
  remainingSeconds,
  startCooldown,
} from '../lib/resendCooldown.js'

// ResendLink — the "email did not arrive?" control under every screen that
// sends an email (forgot password, sign-up verification).
//
// Rules (field-test fix-pack):
//   * After an email is sent the button shows "Resend in 45s" for 60 s.
//   * The DEADLINE is stored in sessionStorage, so refreshing the page cannot
//     shorten the wait or allow rapid re-sending.
//   * A rate-limit response locks it for 5 minutes instead.
//   * Disabled while counting and while sending.
//   * The raw provider text is never rendered — see lib/emailErrors.js.
//
// The caller owns the actual Supabase call (onSend) so each screen keeps its
// own endpoint, redirect target and copy.

export default function ResendLink({
  onSend,
  label = 'Resend email',
  sentNotice = 'Email sent again. Check your inbox and spam.',
  scope = 'email',
}) {
  const storage = typeof window === 'undefined' ? null : window.sessionStorage
  const key = cooldownKey(scope)

  const [remaining, setRemaining] = useState(() => {
    const left = remainingSeconds(storage, key)
    if (left > 0) return left
    // Mounted right after an email was sent: start the 60 s window.
    startCooldown(storage, key, RESEND_COOLDOWN_SECONDS)
    return RESEND_COOLDOWN_SECONDS
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // Recount from the stored deadline every second: a refresh, a second tab or
  // a throttled timer can never make the button unlock early.
  useEffect(() => {
    const tick = () => setRemaining(remainingSeconds(storage, key))
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  async function handleClick() {
    if (busy || remaining > 0) return
    setBusy(true)
    setError('')
    setNotice('')

    let result
    try {
      result = await onSend()
    } catch (thrown) {
      result = { error: thrown }
    }

    setBusy(false)
    const sendError = result?.error

    if (sendError) {
      // Rate limited → calm message + a longer lock so the project-wide
      // allowance is not hammered. Other failures stay retryable.
      if (isRateLimitError(sendError)) {
        startCooldown(storage, key, RATE_LIMIT_COOLDOWN_SECONDS)
        setRemaining(remainingSeconds(storage, key))
      }
      setError(emailErrorMessage(sendError))
      return
    }

    startCooldown(storage, key, RESEND_COOLDOWN_SECONDS)
    setRemaining(remainingSeconds(storage, key))
    setNotice(sentNotice)
  }

  const cooling = remaining > 0
  const buttonText = busy ? 'Sending…' : cooling ? `Resend in ${remaining}s` : label

  return (
    <div className="resend">
      <button
        type="button"
        className="resend-btn"
        onClick={handleClick}
        disabled={busy || cooling}
      >
        {buttonText}
      </button>
      {notice && <p className="resend-notice" role="status">{notice}</p>}
      {error && <p className="resend-error" role="alert">{error}</p>}
    </div>
  )
}
