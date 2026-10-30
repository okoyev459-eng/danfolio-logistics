import { describe, expect, it } from 'vitest'
import { validCoord } from '../src/lib/geo'

// The map renders a marker only for usable coordinates. Live data currently
// stores NULL coordinates everywhere, and 0,0 is the classic "unknown" trap
// (it sits in the Atlantic gulf of Guinea and would zoom the map to Africa).
describe('validCoord', () => {
  it('accepts real coordinates', () => {
    expect(validCoord({ lat: 8.4799, lng: 4.5226 })).toBe(true)
    expect(validCoord({ lat: '8.4799', lng: '4.5226' })).toBe(true)
  })

  it('rejects null / missing coordinates', () => {
    expect(validCoord({ lat: null, lng: null })).toBe(false)
    expect(validCoord({ lat: 8.4, lng: null })).toBe(false)
    expect(validCoord(null)).toBe(false)
    expect(validCoord(undefined)).toBe(false)
  })

  it('rejects the 0,0 placeholder', () => {
    expect(validCoord({ lat: 0, lng: 0 })).toBe(false)
  })

  it('rejects non-numeric values', () => {
    expect(validCoord({ lat: 'abc', lng: 4.5 })).toBe(false)
    expect(validCoord({})).toBe(false)
  })
})
