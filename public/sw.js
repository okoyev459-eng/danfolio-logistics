importScripts('/cache-rules.js')

const SHELL_CACHE = 'danfolio-shell-v1'
const STATIC_CACHE = 'danfolio-static-v1'
const APP_SHELL = '/index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.add(APP_SHELL))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // Never return a cached app shell or asset for auth/payment/data routes,
  // including navigation requests that resolve to protected paths.
  if (self.danfolioCacheRules.isBlockedRequestPath(url.pathname)) return

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstShell(request))
    return
  }

  if (!self.danfolioCacheRules.isSafeStaticRequest(url.pathname)) return
  event.respondWith(cacheFirstStatic(request))
})

async function networkFirstShell(request) {
  try {
    const response = await fetch(request)
    if (
      response.ok &&
      String(response.headers.get('content-type') || '').toLowerCase().includes('text/html')
    ) {
      const cache = await caches.open(SHELL_CACHE)
      cache.put(APP_SHELL, response.clone())
    }
    return response
  } catch {
    const cached = await caches.match(APP_SHELL)
    return cached || new Response('Offline', { status: 503, statusText: 'Offline' })
  }
}

async function cacheFirstStatic(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  const response = await fetch(request)
  if (response.ok) {
    const cache = await caches.open(STATIC_CACHE)
    cache.put(request, response.clone())
  }
  return response
}
