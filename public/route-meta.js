// Per-route metadata for this single-page app.
//
// The static tags in index.html describe the home route; once the route is
// known this rewrites title/description/canonical/share tags to match it, and
// marks the signed-in app areas noindex (they need a session and would only
// produce empty results for Google). Plain JS, no deps.
//
// It lives in its own file (not inline in index.html) so the Content-Security
// -Policy can forbid inline scripts entirely.
;(function () {
  var BASE = 'https://danfolio-logistics.vercel.app'
  var ROUTES = {
    '/': {
      t: 'Danfolio Logistics | Campus Keke and Shuttle Booking',
      d: 'Book campus keke and shuttle rides with Danfolio Logistics — fixed fares, verified riders and live tracking. Reserve, pay in the app and ride with proof.',
    },
    '/login': {
      t: 'Sign in — Danfolio Ride',
      d: 'Sign in to Danfolio Ride — students and verified keke riders sign in to book, track and pay for campus trips.',
    },
    '/signup': {
      t: 'Create account — Danfolio Ride',
      d: 'Create your Danfolio Ride account with your email and phone number, then book campus rides at fixed fares.',
    },
    '/forgot-password': {
      t: 'Reset password — Danfolio Ride',
      d: 'Reset your Danfolio Ride password.',
    },
  }
  var path = location.pathname.replace(/\/+$/, '') || '/'
  var route = ROUTES[path]

  function setMeta(selector, content) {
    var el = document.querySelector(selector)
    if (el) el.setAttribute('content', content)
  }
  function setCanonical(href) {
    var el = document.querySelector('link[rel="canonical"]')
    if (!el) {
      el = document.createElement('link')
      el.rel = 'canonical'
      document.head.appendChild(el)
    }
    el.setAttribute('href', href)
  }

  if (route) {
    document.title = route.t
    setMeta('meta[name="description"]', route.d)
    setMeta('meta[property="og:title"]', route.t)
    setMeta('meta[property="og:description"]', route.d)
    setMeta('meta[property="og:url"]', BASE + path)
    setMeta('meta[name="twitter:title"]', route.t)
    setMeta('meta[name="twitter:description"]', route.d)
    setCanonical(BASE + path)
  } else {
    var robots = document.createElement('meta')
    robots.setAttribute('name', 'robots')
    robots.setAttribute('content', 'noindex')
    document.head.appendChild(robots)
    var canon = document.querySelector('link[rel="canonical"]')
    if (canon) canon.parentNode.removeChild(canon)
  }
})()
