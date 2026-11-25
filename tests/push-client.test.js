import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// push-client.test.js — drift-checks for the FRONTEND half of the
// notification stack (service worker, manifest, subscription module,
// bridge wiring). Same idea as notifications.test.js / policy.test.js:
// if someone edits these files in a way that breaks push delivery or
// leaks a secret into the browser bundle, the suite fails instead of
// the app silently diverging.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
}

const sw = read('public/sw.js')
const push = read('src/lib/push.js')
const bridge = read('src/components/NotificationBridge.jsx')
const app = read('src/App.jsx')
const main = read('src/main.jsx')
const indexHtml = read('index.html')
const manifest = JSON.parse(read('public/manifest.json'))

describe('service worker (public/sw.js)', () => {
  it('displays pushes via showNotification', () => {
    expect(sw).toMatch(/addEventListener\('push'/)
    expect(sw).toMatch(/showNotification/)
  })

  it('routes taps by user_role to the right in-app screen', () => {
    expect(sw).toMatch(/user_role/)
    expect(sw).toContain("'/keke'")
    expect(sw).toContain('`/student/ride/${rideId}`')
    expect(sw).toContain("'/admin'")
  })

  it('focuses an existing window before opening a new one', () => {
    expect(sw).toMatch(/notificationclick/)
    expect(sw).toMatch(/clients\.matchAll/)
    expect(sw).toMatch(/openWindow/)
  })

  it('makes no external requests (no analytics, no tracking)', () => {
    expect(sw).not.toMatch(/fetch\(/)
    expect(sw).not.toMatch(/XMLHttpRequest/)
    expect(sw).not.toMatch(/https?:\/\//)
  })
})

describe('web app manifest (public/manifest.json)', () => {
  it('has the fields Android Chrome requires to install (and to push)', () => {
    expect(manifest.name).toBeTruthy()
    expect(manifest.short_name).toBeTruthy()
    expect(manifest.start_url).toBe('/')
    expect(manifest.scope).toBe('/')
    expect(manifest.display).toBe('standalone')
    expect(Array.isArray(manifest.icons)).toBe(true)
    expect(manifest.icons.length).toBeGreaterThan(0)
  })

  it('uses only same-origin icon paths', () => {
    for (const icon of manifest.icons) {
      expect(icon.src.startsWith('/')).toBe(true)
    }
  })
})

describe('subscription module (src/lib/push.js)', () => {
  it('reads only the PUBLIC VAPID key from env', () => {
    expect(push).toContain('VITE_VAPID_PUBLIC_KEY')
    // The private key must never appear anywhere in frontend source.
    expect(push).not.toContain('VAPID_PRIVATE_KEY')
    expect(push).not.toMatch(/BEGIN PRIVATE KEY/)
  })

  it('subscribes with userVisibleOnly and the applicationServerKey', () => {
    expect(push).toMatch(/userVisibleOnly:\s*true/)
    expect(push).toMatch(/applicationServerKey/)
  })

  it('persists the subscription upsert-on-endpoint (own row, no dupes)', () => {
    expect(push).toMatch(/from\('push_subscriptions'\)/)
    expect(push).toMatch(/onConflict: 'endpoint'/)
  })

  it('rolls back an unsaved subscription instead of leaving a ghost', () => {
    expect(push).toMatch(/subscription\.unsubscribe\(\)/)
  })

  it('only ever requests permission from an explicit enable call', () => {
    expect(push).toMatch(/requestPermission/)
    // Exactly one requestPermission site — inside enablePush, which the
    // UI calls from a button tap.
    expect(push.match(/requestPermission/g)?.length).toBe(1)
  })
})

describe('wiring (bridge / app / entry / index.html)', () => {
  it('NotificationBridge is mounted in App.jsx', () => {
    expect(app).toMatch(/<NotificationBridge \/>/)
  })

  it('App.jsx is rendered inside AuthProvider (main.jsx)', () => {
    expect(main).toMatch(/<AuthProvider>/)
    expect(main).toMatch(/<App \/>/)
  })

  it('service worker is registered on startup', () => {
    expect(main).toMatch(/serviceWorker\.register\('\/sw\.js'/)
  })

  it('index.html links the manifest', () => {
    expect(indexHtml).toMatch(/<link rel="manifest" href="\/manifest\.json"/)
  })

  it('bridge toasts are visual only — never system notifications', () => {
    // The service worker must remain the single source of system alerts,
    // otherwise every event double-pops.
    expect(bridge).not.toMatch(/new Notification\(/)
    expect(bridge).not.toMatch(/showNotification/)
    expect(bridge).toMatch(/import '\.\/notification-bridge\.css'/)
  })

  it('bridge re-syncs the subscription silently on login', () => {
    expect(bridge).toMatch(/syncPushSubscription\(\)/)
  })

  it('bridge subscribes to realtime INSERTs filtered to the signed-in user', () => {
    expect(bridge).toMatch(/event: 'INSERT'/)
    expect(bridge).toMatch(/table: 'notifications'/)
    expect(bridge).toMatch(/filter: `user_id=eq\.\$\{session\.user\.id\}`/)
  })
})

describe('rider presence hooks (src/pages/keke/Home.jsx)', () => {
  const kekeHome = read('src/pages/keke/Home.jsx')

  it('heartbeats through the server-stamped keke_heartbeat RPC first', () => {
    expect(kekeHome).toMatch(/supabase\.rpc\('keke_heartbeat'/)
    // Legacy column write stays as the fallback path.
    expect(kekeHome).toMatch(/from\('kekes'\)\s*\n\s*\.update\(update\)/)
  })

  it('backgrounding the app flips an online rider offline — never on_trip', () => {
    expect(kekeHome).toMatch(/addEventListener\('visibilitychange'/)
    expect(kekeHome).toMatch(/addEventListener\('pagehide'/)
    expect(kekeHome).toMatch(/rpc\('keke_set_presence', \{ p_status: 'offline' \}\)/)
    // The guard sits in front of every background/logout flip.
    expect(kekeHome).toMatch(/if \(!onlineRef\.current \|\| onTripRef\.current\) return/)
  })

  it('signing out goes offline first (no ghost online row)', () => {
    expect(kekeHome).toMatch(/async function handleSignOut/)
    expect(kekeHome).toMatch(/onClick=\{handleSignOut\}/)
    expect(kekeHome).toMatch(/if \(online && !onTrip\) \{\s*\n\s*try \{\s*\n\s*await supabase\.rpc\('keke_set_presence'/)
  })

  it('keeps the existing 20s-era direct-write presence toggle intact', () => {
    // toggleOnline still writes its own row (station/queue handling lives
    // there) — the RPCs were added alongside, not instead.
    expect(kekeHome).toMatch(/async function toggleOnline/)
    expect(kekeHome).toMatch(/update\(update\)\s*\n\s*\.eq\('id', userId\)/)
  })
})
