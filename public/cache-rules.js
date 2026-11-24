/* Shared by the service worker and the UI regression tests.
 * Only first-party, public, versioned static assets may enter the cache.
 * Auth endpoints, Supabase data, payment responses and ride state are never
 * eligible, even if a deployment proxies them through the app origin. */
(function (scope) {
  const blockedPrefixes = [
    '/auth',
    '/rest',
    '/functions',
    '/realtime',
    '/storage',
    '/api/',
    '/paystack',
    '/payment',
    '/private',
    '/user/',
    '/src/',
    '/sw.js',
  ]

  function isBlockedRequestPath(pathname) {
    const path = String(pathname || '').toLowerCase()
    return blockedPrefixes.some((prefix) => path.startsWith(prefix))
  }

  function isSafeStaticRequest(pathname) {
    const path = String(pathname || '').toLowerCase()
    if (!path || path === '/') return false // navigations use a network-first app shell
    if (isBlockedRequestPath(path)) return false

    // Tight allowlist: only known public, versioned/static files. This avoids
    // accidentally caching API/private responses that happen to end with a
    // static extension if they bypass prefix checks in some deployments.
    return (
      path.startsWith('/assets/') ||
      path.startsWith('/icons/') ||
      path === '/manifest.webmanifest' ||
      path === '/favicon.svg' ||
      path === '/robots.txt'
    )
  }

  scope.danfolioCacheRules = { isSafeStaticRequest, isBlockedRequestPath }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { isSafeStaticRequest, isBlockedRequestPath }
  }
})(typeof self !== 'undefined' ? self : globalThis)
