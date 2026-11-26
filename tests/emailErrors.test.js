import { describe, expect, it } from 'vitest'
import {
  EMAIL_SEND_FAILED_MESSAGE,
  RATE_LIMIT_MESSAGE,
  SIGN_IN_FAILED_MESSAGE,
  emailErrorMessage,
  isRateLimitError,
  resetPasswordErrorMessage,
  signInErrorMessage,
  signUpErrorMessage,
} from '../src/lib/emailErrors.js'

// The raw provider text must never reach the screen. These tests pin the
// mapping that turns "email rate limit exceeded" into one calm sentence.

const rateLimited = () => ({
  status: 429,
  code: 'over_email_send_rate_limit',
  message: 'email rate limit exceeded',
})

describe('isRateLimitError', () => {
  it('recognises the 429 status', () => {
    expect(isRateLimitError({ status: 429, message: 'whatever' })).toBe(true)
  })

  it('recognises the rate-limit message forms', () => {
    expect(isRateLimitError({ message: 'email rate limit exceeded' })).toBe(true)
    expect(isRateLimitError({ message: 'Email rate_limit exceeded' })).toBe(true)
    expect(isRateLimitError({ message: 'Too many requests' })).toBe(true)
    expect(
      isRateLimitError({
        message: 'For security purposes, you can only request this after 42 seconds.',
      }),
    ).toBe(true)
  })

  it('recognises the over_email_send_rate_limit code', () => {
    expect(isRateLimitError({ code: 'over_email_send_rate_limit' })).toBe(true)
  })

  it('does not treat an ordinary failure as rate limiting', () => {
    expect(isRateLimitError({ message: 'Invalid login credentials' })).toBe(false)
    expect(isRateLimitError(null)).toBe(false)
  })
})

describe('emailErrorMessage', () => {
  it('maps a rate limit to the calm, actionable sentence', () => {
    expect(emailErrorMessage(rateLimited())).toBe(RATE_LIMIT_MESSAGE)
    expect(RATE_LIMIT_MESSAGE).toBe(
      'Too many emails were requested. Please wait a few minutes and try again.',
    )
  })

  it('never includes the raw provider text', () => {
    const shown = emailErrorMessage(rateLimited())
    expect(shown.toLowerCase()).not.toContain('rate limit exceeded')
    expect(shown.toLowerCase()).not.toContain('429')
  })

  it('uses a generic, non-technical fallback for other failures', () => {
    expect(emailErrorMessage({ message: 'socket hang up' })).toBe(EMAIL_SEND_FAILED_MESSAGE)
    expect(emailErrorMessage(null)).toBe('')
  })
})

describe('signInErrorMessage', () => {
  it('never shows an email/rate-limit message on sign-in', () => {
    const shown = signInErrorMessage(rateLimited())
    expect(shown).toBe(SIGN_IN_FAILED_MESSAGE)
    expect(shown).not.toBe(RATE_LIMIT_MESSAGE)
    expect(shown.toLowerCase()).not.toContain('email was requested')
  })

  it('explains an unconfirmed address without the raw provider text', () => {
    expect(signInErrorMessage({ message: 'Email not confirmed' })).toContain(
      'needs email confirmation',
    )
    expect(signInErrorMessage({ message: 'Invalid login credentials' })).toContain(
      'not correct',
    )
  })

  it('falls back to a neutral message', () => {
    expect(signInErrorMessage({ message: 'boom' })).toBe(SIGN_IN_FAILED_MESSAGE)
  })
})

describe('signUpErrorMessage', () => {
  it('uses the email wording when the confirmation email is throttled', () => {
    expect(signUpErrorMessage(rateLimited())).toBe(RATE_LIMIT_MESSAGE)
  })

  it('explains an existing account', () => {
    expect(signUpErrorMessage({ message: 'User already registered' })).toContain(
      'already exists',
    )
  })
})

describe('resetPasswordErrorMessage', () => {
  it('maps an expired session to the new-link wording', () => {
    expect(resetPasswordErrorMessage({ message: 'Auth session missing!' })).toContain(
      'invalid or has expired',
    )
  })

  it('maps a throttle to the calm sentence', () => {
    expect(resetPasswordErrorMessage(rateLimited())).toBe(RATE_LIMIT_MESSAGE)
  })
})
