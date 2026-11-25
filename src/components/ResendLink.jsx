import { useEffect, useState } from 'react'
import './ResendLink.css'

// ResendLink — the "email did not arrive?" control under the forgot-password
// and sign-up verification messages.
//
// It starts life counting down, because it is only mounted after an email has
// just been sent; when the countdown reaches zero the button can send again.
// The caller owns the actual Supabase call (onSend) so both screens keep using
// their own endpoint and redirect options.

const COOLDOWN_SECONDS = 60

// Supabase reports throttling as HTTP 429 with messages like "email rate limit
// exceeded" or "For security purposes, you can only request this after 42
// seconds." Those get a plain-language message instead of the raw text.
function isRateLimited(err) {
  if (!err) return false
  const message = String(err.message ?? '').toLowerCase()
  return (
    err.status === 429 ||
    message.includes('rate limit') ||
    message.includes('too many') ||
    message.includes('security purposes')
  )
}

export default function ResendLink({
  onSend,
  label = 'Resend link',
  sentNotice = '',
  rateLimitNotice = 'Too many emails have been requested. Please wait a minute and try again.',
}) {
  const [remaining, setRemaining] = useState(COOLDOWN_SECONDS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (remaining <= 0) return undefined
    const id = window.setTimeout(() => setRemaining((n) => n - 1), 1000)
    return () => window.clearTimeout(id)
  }, [remaining])

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
      setError(
        isRateLimited(sendError)
          ? rateLimitNotice
          : 'We could not send another email. Please try again in a moment.',
      )
      return
    }

    setNotice(sentNotice)
    setRemaining(COOLDOWN_SECONDS)
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
