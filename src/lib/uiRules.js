// Small, dependency-free rules shared by the UI-only features.
// Keeping these as pure functions makes the mobile behaviour testable with the
// existing Vitest setup (no DOM/jsdom dependency required).

// Booking sheet: visible heights in visibility order. The first snap is 28% of
// the viewport, so at least 72% of the map stays visible when collapsed.
export const BOOKING_SHEET_SNAPS = [0.28, 0.54, 0.88]

export const visibleMapFraction = (sheetFraction) => 1 - Number(sheetFraction)

// Rating popup: only a completed ride with no existing review is eligible.
export const shouldOfferRating = (rideStatus, reviewExists) =>
  rideStatus === 'completed' && !reviewExists

export const isDuplicateReviewError = (error) => {
  const code = String(error?.code ?? '')
  const message = String(error?.message ?? '')
  return code === '23505' || /duplicate key|unique constraint|already reviewed/i.test(message)
}

export const resendSecondsRemaining = (deadlineMs, nowMs = Date.now()) =>
  Math.max(0, Math.ceil((Number(deadlineMs) - Number(nowMs)) / 1000))

export const resendLabel = (seconds, idleLabel, waitingLabel = 'Resend in') =>
  seconds > 0 ? `${waitingLabel} ${seconds}s` : idleLabel

const IOS_UA = /iPad|iPhone|iPod/i

export const isIosInstallDevice = ({
  userAgent = '',
  platform = '',
  maxTouchPoints = 0,
} = {}) =>
  IOS_UA.test(userAgent) ||
  (platform === 'MacIntel' && Number(maxTouchPoints) > 1)

export const isStandaloneDisplay = ({
  standalone = false,
  displayMode = '',
} = {}) => Boolean(standalone) || displayMode === 'standalone'
