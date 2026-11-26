// Auth error wording (spec: field-test fix-pack).
//
// Supabase returns raw provider text such as
//   "email rate limit exceeded"
//   "over_email_send_rate_limit"
//   "For security purposes, you can only request this after 42 seconds."
// That text is never shown to a student. Rate limiting maps to ONE calm,
// actionable sentence; the raw error goes to the console for debugging only.
//
// The built-in Supabase mailer allows only a handful of emails per hour for
// the WHOLE project (rate_limit_email_sent), so a busy signup period trips
// this for everybody. Nothing here changes the server limit — it only stops
// the raw text leaking into the UI and never shows it on a plain sign-in.

export const RATE_LIMIT_MESSAGE =
  'Too many emails were requested. Please wait a few minutes and try again.'

export const EMAIL_SEND_FAILED_MESSAGE =
  'We could not send that email. Please try again in a moment.'

// Kept generic on purpose: sign-in must never surface an email-delivery
// problem, because signing in does not send an email.
export const SIGN_IN_FAILED_MESSAGE =
  'We could not sign you in. Please check your email and password and try again.'

export function isRateLimitError(error) {
  if (!error) return false
  const message = String(error.message ?? error.error_description ?? '').toLowerCase()
  const code = String(error.code ?? error.error_code ?? '').toLowerCase()
  return (
    Number(error.status) === 429 ||
    code === 'over_email_send_rate_limit' ||
    code === 'over_request_rate_limit' ||
    message.includes('rate limit') ||
    message.includes('rate_limit') ||
    message.includes('too many') ||
    message.includes('security purposes')
  )
}

function logRaw(context, error) {
  // Console only — never rendered.
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(`[auth] ${context}:`, error?.message ?? error)
  }
}

// Wording for a screen whose action really does send an email
// (reset link, verification email, resend).
export function emailErrorMessage(error, { fallback = EMAIL_SEND_FAILED_MESSAGE } = {}) {
  if (!error) return ''
  logRaw('email send failed', error)
  return isRateLimitError(error) ? RATE_LIMIT_MESSAGE : fallback
}

// Wording for sign-in. An email-delivery error must never appear here: it is
// either a stale/shared error or a misleading provider message, and the user
// was not sending an email.
export function signInErrorMessage(error, { fallback = SIGN_IN_FAILED_MESSAGE } = {}) {
  if (!error) return ''
  logRaw('sign-in failed', error)
  if (isRateLimitError(error)) return fallback

  const message = String(error.message ?? '').toLowerCase()
  if (message.includes('email not confirmed')) {
    return 'This account still needs email confirmation. Open the link we emailed you, then sign in.'
  }
  if (message.includes('invalid login credentials')) {
    return 'That email or password is not correct. Please try again.'
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return 'We could not reach the server. Check your connection and try again.'
  }
  return fallback
}

// Sign-up can also be throttled (the confirmation email counts against the
// project limit), so it uses the email wording rather than the sign-in one.
export function signUpErrorMessage(error) {
  if (!error) return ''
  logRaw('sign-up failed', error)
  if (isRateLimitError(error)) return RATE_LIMIT_MESSAGE
  const message = String(error.message ?? '').toLowerCase()
  if (message.includes('already registered') || message.includes('already been registered')) {
    return 'An account with that email already exists. Try signing in instead.'
  }
  return 'We could not create your account. Please check your details and try again.'
}

// Password update failures on the reset screen.
export function resetPasswordErrorMessage(error) {
  if (!error) return ''
  logRaw('password update failed', error)
  if (isRateLimitError(error)) return RATE_LIMIT_MESSAGE
  const message = String(error.message ?? '').toLowerCase()
  if (message.includes('session') || message.includes('expired') || message.includes('jwt')) {
    return 'This reset link is invalid or has expired. Please request a new one.'
  }
  if (message.includes('password')) {
    return 'That password is not accepted. Use at least 6 characters and try again.'
  }
  return 'We could not change your password. Please try again.'
}
