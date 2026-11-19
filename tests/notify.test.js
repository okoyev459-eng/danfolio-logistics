import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  notificationPermission,
  notificationsSupported,
  notify,
  requestNotificationPermission,
} from '../src/lib/notify'

// jsdom ships no Notification API, which is exactly the 'unsupported' path.
// For the others, stub the constructor the way a browser exposes it.

class FakeNotification {
  static permission = 'default'
  static requests = []
  static constructed = []

  constructor(title, options) {
    FakeNotification.constructed.push({ title, options })
  }

  static requestPermission() {
    FakeNotification.requests.push(true)
    return Promise.resolve(FakeNotification.permission)
  }
}

function stubNotification(permission) {
  FakeNotification.permission = permission
  FakeNotification.constructed = []
  FakeNotification.requests = []
  // Tests run in the node environment (no jsdom): the support check reads
  // `window.Notification` while bare `Notification` resolves from
  // globalThis — cover both.
  vi.stubGlobal('Notification', FakeNotification)
  vi.stubGlobal('window', { Notification: FakeNotification })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('notification permission helpers', () => {
  it('reports unsupported when the API does not exist', () => {
    expect(notificationsSupported()).toBe(false)
    expect(notificationPermission()).toBe('unsupported')
  })

  it('reports the browser permission when the API exists', () => {
    stubNotification('granted')
    expect(notificationsSupported()).toBe(true)
    expect(notificationPermission()).toBe('granted')
  })

  it('asks the browser on an explicit user gesture (the bell tap)', async () => {
    stubNotification('default')
    await expect(requestNotificationPermission()).resolves.toBe('default')
    expect(FakeNotification.requests).toHaveLength(1)
  })
})

describe('notify', () => {
  it('is silent without permission — never throws, never constructs', () => {
    expect(notify({ title: 'X' })).toBe(false) // unsupported

    stubNotification('denied')
    expect(notify({ title: 'X' })).toBe(false)
    expect(FakeNotification.constructed).toHaveLength(0)

    stubNotification('default')
    expect(notify({ title: 'X' })).toBe(false)
    expect(FakeNotification.constructed).toHaveLength(0)
  })

  it('fires with title, body and a dedupe tag when granted', () => {
    stubNotification('granted')
    const ok = notify({
      tag: 'arrival-123',
      title: 'Your rider has arrived',
      body: 'At Front of MPH',
    })
    expect(ok).toBe(true)
    expect(FakeNotification.constructed).toHaveLength(1)
    expect(FakeNotification.constructed[0]).toEqual({
      title: 'Your rider has arrived',
      options: { body: 'At Front of MPH', tag: 'arrival-123' },
    })
  })

  it('needs a title', () => {
    stubNotification('granted')
    expect(notify({})).toBe(false)
    expect(notify({ title: '' })).toBe(false)
    expect(FakeNotification.constructed).toHaveLength(0)
  })
})
