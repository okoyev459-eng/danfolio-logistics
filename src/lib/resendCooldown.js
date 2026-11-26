// Resend cooldown rules (spec: field-test fix-pack).
//
// The end timestamp — not a countdown number — is what gets persisted, so a
// page refresh or a second tab cannot shorten the wait: remaining time is
// always recomputed from the stored deadline.
//
//   60 s  — after every successfully sent email
//   5 min — after a rate-limit response, so a throttled student cannot keep
//           hammering the project-wide email allowance
//
// Pure functions with an injected storage object so the rules are unit-tested
// without a browser (tests/resendCooldown.test.js).

export const RESEND_COOLDOWN_SECONDS = 60
export const RATE_LIMIT_COOLDOWN_SECONDS = 300

export function cooldownKey(scope, version = 1) {
  return `danfolio.resend.v${version}.${scope}`
}

function safeGet(storage, key) {
  try {
    return storage?.getItem?.(key) ?? null
  } catch {
    return null
  }
}

function safeSet(storage, key, value) {
  try {
    storage?.setItem?.(key, value)
  } catch {
    // Private mode / quota — the in-memory state still works for this page.
  }
}

function safeRemove(storage, key) {
  try {
    storage?.removeItem?.(key)
  } catch {
    // ignore
  }
}

// Remaining whole seconds, or 0 when the deadline has passed (expired keys
// are removed so a stale timestamp cannot linger).
export function remainingSeconds(storage, key, now = Date.now()) {
  const raw = safeGet(storage, key)
  if (!raw) return 0
  const endAt = Number(raw)
  if (!Number.isFinite(endAt)) {
    safeRemove(storage, key)
    return 0
  }
  const left = endAt - now
  if (left <= 0) {
    safeRemove(storage, key)
    return 0
  }
  return Math.ceil(left / 1000)
}

// Store a deadline `seconds` from now and return the end timestamp.
export function startCooldown(storage, key, seconds, now = Date.now()) {
  const endAt = now + Math.max(0, Math.round(seconds)) * 1000
  safeSet(storage, key, String(endAt))
  return endAt
}

export function clearCooldown(storage, key) {
  safeRemove(storage, key)
}

// Should the button be clickable? Sending is never allowed, and a stored
// deadline always wins.
export function isResendBlocked({ storage, key, now = Date.now(), busy = false }) {
  if (busy) return true
  return remainingSeconds(storage, key, now) > 0
}
