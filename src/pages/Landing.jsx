import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import './landing.css'

// Public landing page — a faithful port of the approved Stitch mockup
// (stitch_danfolio_rides_campus_landing_page) onto the app's own stack:
// plain React + CSS, the existing blue/white tokens, and inline SVG icons
// instead of the mockup's Tailwind/Material-Symbols CDNs (no new deps, and
// the page still renders offline). Fabricated testimonials and hot-linked
// sample photos from the mockup are deliberately left out — real quotes can
// be added later once real riders have taken real trips.

const ICONS = {
  keke: (
    <>
      <path d="M3 16v-4a2 2 0 0 1 2-2h7l3.5 4H19a2 2 0 0 1 2 2v2" />
      <path d="M3 16h18" />
      <circle cx="7.5" cy="18" r="1.8" />
      <circle cx="16.5" cy="18" r="1.8" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7 3v6c0 4-3 7-7 8-4-1-7-4-7-8V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </>
  ),
  receipt: (
    <>
      <path d="M6 3h12v18l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21V3z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  nav: <path d="M21 3L3 10.5l7.5 3L13.5 21 21 3z" />,
  pay: (
    <>
      <rect x="3" y="7" width="18" height="10" rx="2" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M6.5 10.5h.01M17.5 13.5h.01" />
    </>
  ),
  route: (
    <>
      <circle cx="5" cy="19" r="2" />
      <circle cx="19" cy="5" r="2" />
      <path d="M7 17.5L17 7" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-6-5.1-6-10a6 6 0 1 1 12 0c0 4.9-6 10-6 10z" />
      <circle cx="12" cy="11" r="2.2" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
    </>
  ),
  building: (
    <>
      <path d="M4 21V6l8-3 8 3v15" />
      <path d="M9 21v-5h6v5" />
      <path d="M9 10.5h1.5M13.5 10.5H15" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ),
  gauge: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 12l4-3.5" />
      <path d="M12 3.5v2M20.5 12h-2M3.5 12h2" />
    </>
  ),
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
}

// Exported so the auth pages reuse the exact same brand + icon set
// (single source — no duplicated component or SVG paths).
export function Icon({ name, size = 20, className = '' }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  )
}

export function Brand({ compact = false }) {
  return (
    <span className={'lp-brand' + (compact ? ' compact' : '')}>
      <span className="lp-logo">
        <Icon name="keke" size={20} />
      </span>
      <span className="lp-brand-name">
        Danfolio Rides<em>Campus micro-transit</em>
      </span>
    </span>
  )
}

// The hero visual is a drawn UI card (real app locations, no invented
// numbers): it shows how a trip looks in the app instead of a stock photo.
function TripCardMock() {
  return (
    <div className="lp-hero-card" aria-hidden="true">
      <div className="lp-hero-card-top">
        <span className="lp-live"><i /> Live trip</span>
        <span className="lp-keke-chip"><Icon name="keke" size={14} /> Your keke</span>
      </div>
      <div className="lp-hero-route">
        <div className="lp-hero-leg">
          <span className="lp-dot" />
          <div>
            <strong>Library Gate</strong>
            <em>Pick-up point</em>
          </div>
        </div>
        <div className="lp-hero-leg">
          <span className="lp-dot lp-dot-end" />
          <div>
            <strong>Hostel M</strong>
            <em>Destination</em>
          </div>
        </div>
        <div className="lp-hero-track"><i /></div>
      </div>
      <div className="lp-hero-card-foot">
        <div>
          <span className="lp-mini-label">Fare</span>
          <strong>Shown before you ride</strong>
        </div>
        <span className="lp-pill">Heading to you · ≈ time</span>
      </div>
      <div className="lp-hero-mapstrip">
        <svg viewBox="0 0 320 64" preserveAspectRatio="none">
          <path className="lp-strip-road" d="M0 44 C60 44 70 20 130 20 S240 44 320 30" />
          <path className="lp-strip-route" d="M0 44 C60 44 70 20 130 20 S240 44 320 30" />
        </svg>
        <span className="lp-strip-keke"><Icon name="keke" size={13} /></span>
        <span className="lp-strip-pin"><Icon name="pin" size={13} /></span>
      </div>
    </div>
  )
}

const GUARANTEES = [
  { icon: 'pay', label: 'Fixed fares' },
  { icon: 'shield', label: 'Verified riders' },
  { icon: 'receipt', label: 'Ticket slip as proof' },
  { icon: 'nav', label: 'Live tracking' },
]

const STEPS = [
  {
    n: '01',
    icon: 'pin',
    title: 'Choose your route',
    body: 'Pick your campus pick-up point and destination — Library Gate, Hostel, Cafeteria. The fixed campus fare appears immediately with zero bargaining and zero surge.',
    foot: 'Drop or Along — two ways to ride',
  },
  {
    n: '02',
    icon: 'pay',
    title: 'Pay before you ride',
    body: 'Approve the fare in the app with your card. No cash, no arguments at the gate — your payment is confirmed before the keke even moves.',
    foot: 'Instant in-app confirmation',
  },
  {
    n: '03',
    icon: 'receipt',
    title: 'Ride with proof',
    body: 'Get a ticket slip with a booking code, watch your keke approach in real time, and keep the receipt as proof for every trip.',
    foot: 'Ticket + code + live ETA',
  },
]

const TRACK_POINTS = [
  {
    icon: 'nav',
    title: 'Real-time keke telemetry on the campus grid',
    body: 'Your rider device publishes live GPS while a trip is active — the marker on your map moves with the keke, with honest live/stale/offline states.',
  },
  {
    icon: 'clock',
    title: 'Arrival time, not guesswork',
    body: 'See how long the keke needs to reach you — road ETA when the router answers, an honest distance estimate when it cannot.',
  },
  {
    icon: 'gauge',
    title: 'Freshness you can trust',
    body: 'Every position carries its age. When data goes stale, the app says so instead of freezing a marker on the map.',
  },
]

const WAYS = [
  {
    icon: 'keke',
    name: 'Drop Ride',
    tag: 'Direct dispatch',
    lead: 'Door-to-door. Your keke arrives directly at your pick-up spot.',
    body: 'Ideal for late nights, moving luggage, or rainy days — the rider comes to your gate and takes you straight to your destination.',
    points: ['Pick your exact point', 'Live ETA to your gate', 'Pay before boarding'],
  },
  {
    icon: 'route',
    name: 'Along Ride',
    tag: 'Station join',
    lead: 'Join a ride at a campus station along a shared route.',
    body: 'Pick a station — Auditorium, Chapel Junction, Front of MPH — and share the trip with students heading the same way.',
    points: ['Fixed station network', 'Share the ride', 'Same fixed fares'],
  },
]

const AUDIENCES = [
  {
    icon: 'person',
    title: 'For Students',
    points: [
      'Know the price before boarding',
      'Live GPS locator & arrival time',
      'Digital proof of payment for every trip',
    ],
  },
  {
    icon: 'keke',
    title: 'For Keke Riders',
    points: [
      'Verified and registered by operations',
      'Accept trip offers directly in the app',
      'Daily earnings and rating at a glance',
    ],
  },
  {
    icon: 'building',
    title: 'For Campus Operations',
    points: [
      'Set and enforce fixed campus fares',
      'Manage stations, fleet and locations',
      'Review trips, reports and incidents',
    ],
  },
]

export default function Landing() {
  // Scroll reveals: below-fold sections start hidden (html.has-js is set in
  // main.jsx BEFORE first paint, so there is no flash — and with JS off
  // everything simply stays visible) and fade+rise in one-shot as they
  // enter the viewport.
  useEffect(() => {
    const targets = document.querySelectorAll(
      '.lp-section-head, .lp-step, .lp-track-item, .lp-way, .lp-audience, .lp-trust-item, .lp-about-grid, .lp-slogan, .lp-cta-band-inner',
    )
    if (!targets.length) return
    if (!('IntersectionObserver' in window)) {
      targets.forEach((t) => t.classList.add('rv-in'))
      return
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add('rv-in')
            io.unobserve(e.target)
          }
        }
      },
      { rootMargin: '0px 0px -6% 0px', threshold: 0.12 },
    )
    targets.forEach((t) => io.observe(t))
    return () => io.disconnect()
  }, [])

  return (
    <div className="lp">
      <header className="lp-header">
        <div className="lp-shell lp-header-inner">
          <Link to="/" className="plain"><Brand /></Link>
          <nav className="lp-nav">
            <a href="#how-it-works" className="lp-nav-link">How it works</a>
            <a href="#two-ways" className="lp-nav-link">Ways to ride</a>
            <a href="#about" className="lp-nav-link">About</a>
            <Link to="/login" className="lp-nav-link">Sign in</Link>
            <Link to="/signup" className="lp-cta lp-cta-sm">Get started</Link>
          </nav>
        </div>
      </header>

      <main>
        {/* HERO */}
        <section className="lp-hero">
          <div className="lp-shell lp-hero-grid">
            <div className="lp-hero-copy">
              <span className="lp-badge">
                <i className="lp-badge-dot" />
                Campus Transit &amp; Micro-Mobility Network
                <span className="lp-badge-sep">|</span>
                <span className="lp-badge-node">Zone 01</span>
              </span>
              <h1>
                Fixed fares. Verified riders.
                <span>Safe rides on campus.</span>
              </h1>
              <p className="lp-lead">
                Book a keke from the library gate to your hostel. You see the
                price before you ride, pay in the app, and get proof of
                payment for every trip.
              </p>
              <div className="lp-hero-ctas">
                <Link to="/signup" className="lp-cta">
                  <Icon name="keke" size={18} /> Book a ride
                </Link>
                <Link to="/login" className="lp-cta lp-cta-ghost">
                  <Icon name="shield" size={18} /> Ride with us
                </Link>
              </div>
              <ul className="lp-hero-facts">
                <li><Icon name="check" size={16} /> Fixed campus fares</li>
                <li><Icon name="check" size={16} /> Live GPS tracking</li>
                <li><Icon name="check" size={16} /> Pay before you ride</li>
              </ul>
            </div>
            <div className="lp-hero-visual">
              <TripCardMock />
            </div>
          </div>
        </section>

        {/* TRUST STRIP */}
        <section className="lp-trust">
          <div className="lp-shell lp-trust-inner">
            <span className="lp-trust-label">Platform guarantees</span>
            <div className="lp-trust-items">
              {GUARANTEES.map((g, i) => (
                <span key={g.label} className="lp-trust-item">
                  {i > 0 && <span className="lp-trust-dot" aria-hidden="true">·</span>}
                  <Icon name={g.icon} size={17} />
                  {g.label}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* HOW IT WORKS */}
        <section className="lp-section" id="how-it-works">
          <div className="lp-shell">
            <div className="lp-section-head">
              <span className="lp-kicker"><Icon name="route" size={14} /> Operational protocol</span>
              <h2>Three steps from booking to arrival</h2>
              <p>Designed for zero bargaining, verified security, and fast campus turnaround.</p>
            </div>
            <div className="lp-steps">
              {STEPS.map((s) => (
                <article key={s.n} className="lp-step">
                  <div className="lp-step-top">
                    <span className="lp-step-n">{s.n}</span>
                    <span className="lp-step-icon"><Icon name={s.icon} size={20} /></span>
                  </div>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                  <div className="lp-step-foot"><Icon name="check" size={15} /> {s.foot}</div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* TRACK YOUR RIDE */}
        <section className="lp-section lp-section-dim" id="track-ride">
          <div className="lp-shell lp-track-grid">
            <div className="lp-track-copy">
              <span className="lp-kicker"><Icon name="nav" size={14} /> Live campus telemetry</span>
              <h2>Continuous trip tracking across campus with zero blind spots</h2>
              <p className="lp-lead-sm">
                Situational awareness from pickup dispatch to destination
                arrival — built for campus networks and phones that drop in
                and out of coverage.
              </p>
            </div>
            <div className="lp-track-list">
              {TRACK_POINTS.map((t) => (
                <div key={t.title} className="lp-track-item">
                  <span className="lp-track-icon"><Icon name={t.icon} size={20} /></span>
                  <div>
                    <h4>{t.title}</h4>
                    <p>{t.body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* TWO WAYS TO RIDE */}
        <section className="lp-section" id="two-ways">
          <div className="lp-shell">
            <div className="lp-section-head lp-section-head-center">
              <span className="lp-kicker"><Icon name="keke" size={14} /> Transit modes</span>
              <h2>Two ways to ride across campus</h2>
              <p>Pick doorstep on-demand pickup or a station along the route.</p>
            </div>
            <div className="lp-ways">
              {WAYS.map((w) => (
                <article key={w.name} className="lp-way">
                  <div className="lp-way-head">
                    <span className="lp-way-icon"><Icon name={w.icon} size={20} /></span>
                    <strong>{w.name}</strong>
                    <span className="lp-way-tag">{w.tag}</span>
                  </div>
                  <p className="lp-way-lead">{w.lead}</p>
                  <p className="lp-way-body">{w.body}</p>
                  <ul className="lp-way-points">
                    {w.points.map((p) => (
                      <li key={p}><Icon name="check" size={15} /> {p}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* BENEFITS */}
        <section className="lp-section lp-section-dim" id="benefits">
          <div className="lp-shell">
            <div className="lp-section-head">
              <span className="lp-kicker"><Icon name="shield" size={14} /> Ecosystem value</span>
              <h2>Built for everyone on campus</h2>
              <p>One transparent transit platform aligning students, riders and campus operations.</p>
            </div>
            <div className="lp-audiences">
              {AUDIENCES.map((a) => (
                <article key={a.title} className="lp-audience">
                  <span className="lp-audience-icon"><Icon name={a.icon} size={24} /></span>
                  <h3>{a.title}</h3>
                  <ul>
                    {a.points.map((p) => (
                      <li key={p}><Icon name="check" size={17} /> <span>{p}</span></li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ABOUT DANFOLIO — the parent company, kept visibly distinct from
            the product. Only facts from the brand brief: DANFOLIO is the
            company, Danfolio Ride is one of its products, more are in
            development. The slogan appears verbatim below. */}
        <section className="lp-section" id="about">
          <div className="lp-shell">
            <div className="lp-section-head">
              <span className="lp-kicker"><Icon name="building" size={14} /> About DANFOLIO</span>
              <h2>The company behind the product</h2>
              <p>
                DANFOLIO is a company that builds products and projects for
                everyday life. Danfolio Ride — the campus transportation
                platform you are using now, shown in-app as Danfolio
                Logistics — is one of them.
              </p>
            </div>
            <div className="lp-about-grid">
              <article className="lp-audience">
                <span className="lp-audience-icon"><Icon name="keke" size={24} /></span>
                <h3>Danfolio Ride</h3>
                <ul>
                  <li><Icon name="check" size={17} /> <span>Fixed campus fares with zero bargaining</span></li>
                  <li><Icon name="check" size={17} /> <span>Verified keke riders and live GPS tracking</span></li>
                  <li><Icon name="check" size={17} /> <span>Pay in the app, keep proof of every trip</span></li>
                </ul>
                <div className="lp-about-cta">
                  <Link to="/signup" className="lp-cta lp-cta-sm">Open the ride app</Link>
                </div>
              </article>
              <article className="lp-audience">
                <span className="lp-audience-icon"><Icon name="route" size={24} /></span>
                <h3>More in development</h3>
                <ul>
                  <li><Icon name="check" size={17} /> <span>More Danfolio products are in development under the same name</span></li>
                  <li><Icon name="check" size={17} /> <span>DANFOLIO is not limited to transportation</span></li>
                </ul>
              </article>
            </div>
            <p className="lp-slogan">Built for Everyday Life.</p>
          </div>
        </section>

        {/* CTA BAND */}
        <section className="lp-cta-band">
          <div className="lp-shell lp-cta-band-inner">
            <span className="lp-cta-chip"><i className="lp-badge-dot" /> Pay before you ride · Verified payments</span>
            <h2>Ready to ride safely across campus?</h2>
            <p>
              Students sign up in under a minute with their email and phone
              number. Keke riders are verified and registered by the Danfolio
              Logistics operations team.
            </p>
            <div className="lp-hero-ctas">
              <Link to="/signup" className="lp-cta lp-cta-white">
                <Icon name="person" size={18} /> Create student account
              </Link>
              <Link to="/login" className="lp-cta lp-cta-outline">
                <Icon name="keke" size={18} /> Rider sign in
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-shell">
          <div className="lp-footer-top">
            <Link to="/" className="plain"><Brand /></Link>
            <nav className="lp-footer-nav">
              <a href="#how-it-works">Protocol</a>
              <a href="#track-ride">Live tracking</a>
              <a href="#two-ways">Ways to ride</a>
              <a href="#about">About DANFOLIO</a>
              <Link to="/login">Sign in</Link>
              <Link to="/signup">Create account</Link>
            </nav>
          </div>
          <div className="lp-footer-bottom">
            <span>Danfolio Ride is a product of DANFOLIO · © 2026 DANFOLIO · Built for Everyday Life.</span>
            <span className="lp-status"><i className="lp-badge-dot" /> Campus Hub active · Zone 01</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
