import { describe, expect, it } from 'vitest'
import { kekeEmail, toLoginEmail } from '../src/lib/kekeLogin'

// Keke login identity rules (must match create-keke's server-side rule:
// lowercase alphanumeric only, then @danfolio.app).
describe('kekeEmail', () => {
  it('lowercases and strips non-alphanumerics', () => {
    expect(kekeEmail('KEKE 214 UNI')).toBe('keke214uni@danfolio.app')
    expect(kekeEmail('KK-007')).toBe('kk007@danfolio.app')
  })

  it('trims surrounding whitespace', () => {
    expect(kekeEmail('  3551  ')).toBe('3551@danfolio.app')
  })

  it('matches the create-keke transform on tricky inputs', () => {
    // create-keke: kn.toLowerCase().replace(/[^a-z0-9]/g, '') + '@danfolio.app'
    const server = (kn) => kn.trim().toUpperCase().replace(/\s+/g, ' ').toLowerCase().replace(/[^a-z0-9]/g, '') + '@danfolio.app'
    for (const input of ['KEKE 214 UNI', 'kk 001', 'ABC-123', '  99  ']) {
      expect(kekeEmail(input)).toBe(server(input))
    }
  })
})

describe('toLoginEmail', () => {
  it('passes emails through untouched', () => {
    expect(toLoginEmail('student@uni.edu')).toBe('student@uni.edu')
  })

  it('converts keke numbers to the hidden email', () => {
    expect(toLoginEmail('KEKE 214 UNI')).toBe('keke214uni@danfolio.app')
  })
})
