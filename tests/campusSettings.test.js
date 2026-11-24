import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAMPUS_CENTER,
  DEFAULT_CAMPUS_ZOOM,
  resolveCampusCamera,
  validateCampusSettings,
} from '../src/lib/campusSettings'

// campus_settings has deliberately NULL coordinates until the real campus
// centre is supplied — these tests pin the "never invent data" contract.
describe('validateCampusSettings', () => {
  it('accepts an empty form (coordinates stay null, nothing invented)', () => {
    const out = validateCampusSettings({
      campus_name: '',
      center_lat: '',
      center_lng: '',
      zoom: '',
    })
    expect(out.ok).toBe(true)
    expect(out.value).toEqual({
      id: 1,
      campus_name: null,
      center_lat: null,
      center_lng: null,
      zoom: null,
    })
  })

  it('trims and keeps a supplied campus name', () => {
    const out = validateCampusSettings({ campus_name: '  My University  ' })
    expect(out.ok).toBe(true)
    expect(out.value.campus_name).toBe('My University')
  })

  it('accepts a valid centre + zoom', () => {
    const out = validateCampusSettings({
      campus_name: 'Campus',
      center_lat: '8.4799',
      center_lng: '4.5226',
      zoom: '15',
    })
    expect(out.ok).toBe(true)
    expect(out.value.center_lat).toBeCloseTo(8.4799)
    expect(out.value.center_lng).toBeCloseTo(4.5226)
    expect(out.value.zoom).toBe(15)
  })

  it('rejects a half-entered centre', () => {
    const out = validateCampusSettings({ center_lat: '8.4799', center_lng: '' })
    expect(out.ok).toBe(false)
    expect(out.errors.center).toMatch(/both/i)
  })

  it('rejects non-numeric coordinates', () => {
    const out = validateCampusSettings({ center_lat: 'north', center_lng: '4.5' })
    expect(out.ok).toBe(false)
    expect(out.errors.center).toMatch(/numbers/i)
  })

  it('rejects out-of-range coordinates', () => {
    expect(validateCampusSettings({ center_lat: '95', center_lng: '4.5' }).ok).toBe(false)
    expect(validateCampusSettings({ center_lat: '8.4', center_lng: '181' }).ok).toBe(false)
  })

  it('validates zoom as a whole number between 1 and 20', () => {
    expect(validateCampusSettings({ zoom: 'abc' }).ok).toBe(false)
    expect(validateCampusSettings({ zoom: '0' }).ok).toBe(false)
    expect(validateCampusSettings({ zoom: '21' }).ok).toBe(false)
    expect(validateCampusSettings({ zoom: '14.5' }).ok).toBe(false)
    expect(validateCampusSettings({ zoom: '14' }).ok).toBe(true)
  })

  it('caps an over-long campus name', () => {
    expect(validateCampusSettings({ campus_name: 'x'.repeat(81) }).ok).toBe(false)
  })
})

describe('resolveCampusCamera', () => {
  it('falls back to the default centre when nothing is configured', () => {
    const camera = resolveCampusCamera(null)
    expect(camera.center).toEqual(DEFAULT_CAMPUS_CENTER)
    expect(camera.zoom).toBe(DEFAULT_CAMPUS_ZOOM)
    expect(camera.source).toBe('default')
  })

  it('prefers the admin-supplied database centre', () => {
    const camera = resolveCampusCamera({
      center_lat: 6.5244,
      center_lng: 3.3792,
      zoom: 16,
    })
    expect(camera.center).toEqual({ lat: 6.5244, lng: 3.3792 })
    expect(camera.zoom).toBe(16)
    expect(camera.source).toBe('settings')
  })

  it('ignores a half / invalid database centre instead of inventing one', () => {
    const camera = resolveCampusCamera({ center_lat: 6.5244, center_lng: null })
    expect(camera.center).toEqual(DEFAULT_CAMPUS_CENTER)
    expect(camera.source).toBe('default')
  })

  it('keeps a database zoom even without coordinates', () => {
    const camera = resolveCampusCamera({ center_lat: null, center_lng: null, zoom: 12 })
    expect(camera.zoom).toBe(12)
    expect(camera.center).toEqual(DEFAULT_CAMPUS_CENTER)
  })
})
