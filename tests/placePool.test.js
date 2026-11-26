import { describe, expect, it } from 'vitest'
import {
  buildPlacePool,
  fromKindForMode,
  placeKey,
  placePoint,
  placePoints,
} from '../src/lib/placePool.js'

const rows = [
  { id: 'p-hosta', name: 'Hostel A', kind: 'pickup', mode: 'drop', category: 'Hostel', lat: 6.1, lng: 6.2 },
  { id: 'd-hosta', name: 'Hostel A', kind: 'destination', mode: 'drop', category: 'Hostel', lat: 6.1, lng: 6.2 },
  { id: 'p-lib', name: 'Library Gate', kind: 'pickup', mode: 'drop', category: 'Academic block', lat: 6.3, lng: 6.4 },
  { id: 'd-main', name: 'Main Gate', kind: 'destination', mode: 'drop', category: 'Main gate', lat: 6.5, lng: 6.6 },
  { id: 's-chapel', name: 'Chapel Junction', kind: 'station', mode: 'along', category: 'Stations', lat: 6.7, lng: 6.8 },
  { id: 'd-market', name: 'Market Road', kind: 'destination', mode: 'along', category: 'Landmark', lat: 6.9, lng: 7.0 },
]

describe('placeKey', () => {
  it('normalises case, spacing and padding so one place is one key', () => {
    expect(placeKey('  Hostel   A ')).toBe('hostel a')
    expect(placeKey('HOSTEL A')).toBe(placeKey('hostel a'))
    expect(placeKey(null)).toBe('')
  })
})

describe('buildPlacePool', () => {
  it('merges the pick-up and destination rows of one place into a single entry', () => {
    const pool = buildPlacePool(rows, 'drop')
    const hostelA = pool.filter((p) => p.key === 'hostel a')

    expect(hostelA).toHaveLength(1)
    expect(hostelA[0].rows).toHaveLength(2)
    expect(hostelA[0].fromRow.id).toBe('p-hosta')
    expect(hostelA[0].toRow.id).toBe('d-hosta')
  })

  it('keeps places the admin entered once, usable as either end', () => {
    const pool = buildPlacePool(rows, 'drop')
    const mainGate = pool.find((p) => p.key === 'main gate')

    expect(mainGate.fromRow.id).toBe('d-main')
    expect(mainGate.toRow.id).toBe('d-main')
  })

  it('only lists places of the requested mode', () => {
    const drop = buildPlacePool(rows, 'drop')
    const along = buildPlacePool(rows, 'along')

    expect(drop.map((p) => p.key).sort()).toEqual(['hostel a', 'library gate', 'main gate'])
    expect(along.map((p) => p.key).sort()).toEqual(['chapel junction', 'market road'])
  })

  it('uses station rows as the from role in along mode', () => {
    expect(fromKindForMode('along')).toBe('station')
    expect(fromKindForMode('drop')).toBe('pickup')

    const chapel = buildPlacePool(rows, 'along').find((p) => p.key === 'chapel junction')
    expect(chapel.fromRow.id).toBe('s-chapel')
  })
})

describe('placePoint', () => {
  it('resolves the role row but keeps the merged name, category and pin', () => {
    const place = buildPlacePool(rows, 'drop').find((p) => p.key === 'hostel a')

    expect(placePoint(place, 'from')).toMatchObject({
      id: 'p-hosta',
      name: 'Hostel A',
      category: 'Hostel',
      lat: 6.1,
      lng: 6.2,
    })
    expect(placePoint(place, 'to').id).toBe('d-hosta')
  })

  it('borrows coordinates from the place pair when the role row has none', () => {
    const pool = buildPlacePool(
      [
        { id: 'a', name: 'New Block', kind: 'pickup', mode: 'drop', lat: null, lng: null },
        { id: 'b', name: 'New Block', kind: 'destination', mode: 'drop', lat: 6.42, lng: 6.43 },
      ],
      'drop',
    )

    expect(placePoint(pool[0], 'from')).toMatchObject({ id: 'a', lat: 6.42, lng: 6.43 })
  })

  it('returns null without a place', () => {
    expect(placePoint(null)).toBeNull()
  })
})

describe('placePoints', () => {
  it('offers every other place and never the one already chosen', () => {
    const destinations = placePoints(rows, 'drop', 'to', placeKey('Hostel A'))

    expect(destinations.map((p) => p.name)).toEqual(['Library Gate', 'Main Gate'])
    expect(destinations.every((p) => p.name !== 'Hostel A')).toBe(true)
  })

  it('gives the same number of options for both ends before a choice is made', () => {
    expect(placePoints(rows, 'drop', 'from')).toHaveLength(3)
    expect(placePoints(rows, 'drop', 'to')).toHaveLength(3)
    expect(placePoints(rows, 'drop', 'to', placeKey('Hostel A'))).toHaveLength(2)
  })
})

describe('regression: student pickers after choosing Drop or Along', () => {
  // BookFlow asks for a mode's rows on the server (.eq('mode', mode)) and used
  // to leave `mode` out of its SELECT, so every row arrived without one. The
  // pool then dropped all of them and Drop/Along showed no locations at all.
  const rowsWithoutModeColumn = [
    { id: 'p-hosta', name: 'Hostel A', kind: 'pickup', category: 'Hostel', lat: 6.1, lng: 6.2 },
    { id: 'p-lib', name: 'Library Gate', kind: 'pickup', category: 'Academic block', lat: 6.3, lng: 6.4 },
    { id: 'd-main', name: 'Main Gate', kind: 'destination', category: 'Main gate', lat: 6.5, lng: 6.6 },
  ]

  it('keeps places when the query filtered by mode but did not select it', () => {
    const pool = buildPlacePool(rowsWithoutModeColumn, 'drop')

    expect(pool.map((p) => p.name)).toEqual(['Hostel A', 'Library Gate', 'Main Gate'])
    expect(placePoints(rowsWithoutModeColumn, 'drop', 'from')).toHaveLength(3)
    expect(placePoints(rowsWithoutModeColumn, 'drop', 'to')).toHaveLength(3)
  })

  it('still drops rows that carry a different mode', () => {
    const pool = buildPlacePool(
      [
        { id: 'p-hosta', name: 'Hostel A', kind: 'pickup', mode: 'drop', lat: 6.1, lng: 6.2 },
        { id: 's-chapel', name: 'Chapel Junction', kind: 'station', mode: 'along', lat: 6.7, lng: 6.8 },
      ],
      'drop',
    )

    expect(pool.map((p) => p.name)).toEqual(['Hostel A'])
  })

  it('keeps the pick-up/destination exclusion on those rows', () => {
    const destinations = placePoints(rowsWithoutModeColumn, 'drop', 'to', placeKey('Hostel A'))

    expect(destinations.map((p) => p.name)).toEqual(['Library Gate', 'Main Gate'])
  })
})
