// Danfolio service worker — the only file that DISPLAYS a push.
//
// Registered by src/lib/push.js after the user grants notification
// permission. The backend (notify-tick) encrypts a JSON payload
// { title, body, type, user_role, ride_id, data } and POSTs it to the
// browser's push endpoint; this file turns that payload into a system
// notification and routes the tap to the right in-app screen.
//
// Design notes:
//   * `showNotification` from a push event works WITHOUT permission
//     prompts (permission was already granted to subscribe);
//   * notificationclick focuses an existing window instead of opening a
//     duplicate (standard pattern: clients.matchAll → focus, else open);
//   * tap targets: riders go to /keke (the offer is waiting there),
//     students to /student/ride/:id when the payload carries a ride_id,
//     otherwise the role's home — all SPA routes, so the router takes over;
//   * no analytics, no tracking, no external fetches.

self.addEventListener('install', () => {
  // No waiting/skipWaiting dance needed: this SW has no caching lifecycle.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

function tapTarget(payload) {
  const role = payload?.user_role
  const rideId = payload?.ride_id
  if (role === 'keke') return '/keke'
  if (role === 'student' && rideId) return `/student/ride/${rideId}`
  if (role === 'student') return '/student'
  if (role === 'admin') return '/admin'
  return '/'
}

self.addEventListener('push', (event) => {
  // Malformed / empty pushes still surface as something visible rather
  // than failing silently — a broken sender must not look like "no ride".
  let payload = {}
  try {
    payload = event.data?.json() ?? {}
  } catch {
    payload = { title: 'Danfolio', body: event.data?.text() ?? '' }
  }

  const title = payload.title || 'Danfolio'
  const options = {
    body: payload.body || '',
    tag: payload.type ? `danfolio-${payload.type}` : 'danfolio',
    renotify: true, // a changed update for the same tag re-alerts
    data: { url: tapTarget(payload), type: payload.type ?? null },
    icon: '/logo-mark.png',
    badge: '/favicon.png',
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'

  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })
      // Prefer an already-open tab (focus + navigate) over a new one.
      for (const client of all) {
        if ('focus' in client) {
          await client.focus()
          if ('navigate' in client) await client.navigate(url)
          return
        }
      }
      await self.clients.openWindow(url)
    })(),
  )
})
