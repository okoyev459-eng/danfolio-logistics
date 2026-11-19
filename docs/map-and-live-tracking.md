# Campus map & live Keke tracking

How the Danfolio map stack works, how to configure it, and how to test it.
**No secrets belong in this file or any env var starting with `VITE_`** — the
frontend bundle is public.

---

## 1. Map architecture

| Layer | Choice | Notes |
|---|---|---|
| Rendering | MapLibre GL JS (`maplibre-gl`, already in package.json) | BSD-3-Clause, no API key |
| Tiles + style | OpenFreeMap (default) | Keyless, © OpenStreetMap contributors |
| Map data | OpenStreetMap | The only source of roads — nothing is invented |
| Routing | OSRM-compatible server (public demo by default) | Configurable, keyless |
| Component | `src/components/CampusMap.jsx` | The app's **only** map renderer |
| Live GPS | `ride_locations` table + Supabase Realtime | Migration `20261103100000` |

Every screen that shows a map (`student/Home`, `BookFlow`, `student/Ride`,
`keke/Home`, `admin/Home`, `StationMap`, admin location editor) renders the
same `CampusMap`, so provider changes and fixes land everywhere at once.

Behaviour built into `CampusMap`:

- **Markers are reconciled, not rebuilt.** A live GPS update moves the
  existing keke badge with a short display-only tween. Both endpoints of the
  tween are real fixes — intermediate frames are animation, never data.
- **The camera auto-fits only when the SET of pins changes**, so a moving
  keke never yanks the view. Parents can drive the camera via the ref API
  (`zoomIn/zoomOut/recenter/fitPoints`).
- **Routes are drawn only as returned by the routing provider.** If the
  provider fails or finds no path, the map draws a *dashed grey line labelled
  "Road route unavailable — showing a direct line, not a road route"* and
  reports **no ETA**. A straight line is never presented as a road route.
- **Student route phases are explicit:** searching shows a planned pickup-to-
  destination route; accepted/paid shows the fresh Keke-to-pickup road route;
  arrived shows a trip-route preview; on-trip uses the fresh Keke position to
  route to the destination. Stale GPS never drives a live route or ETA.
- **Basemap tile failures remain visible:** a failed vector-tile/resource
  request raises a retry banner instead of silently leaving location markers
  on an incomplete background.
- **Attribution is always on** (OSM/OpenFreeMap terms) via MapLibre's
  `AttributionControl`.
- **Failure is graceful**: if the style can't load (blocked network/DNS),
  the component renders an error card instead of a blank box, and the rest
  of the screen keeps working.

## 2. Configuring the map provider

Set `VITE_MAP_STYLE_URL` to **any MapLibre style URL** (style + tiles travel
together):

```env
VITE_MAP_STYLE_URL=https://tiles.openfreemap.org/styles/liberty    # default
```

Other keyless starting points: `https://tiles.openfreemap.org/styles/bright`,
`https://tiles.openfreemap.org/styles/positron`. Paid/keyed providers
(MapTiler, Google, Mapbox) work too but need their own key **server-side or
in a Vite env var you accept as public** — ask before switching, and mind
their billing.

### Initial camera (campus centre)

Precedence, highest first:

1. Admin → **Manage campus locations → Campus settings** (`campus_settings`
   row `id = 1` in Supabase) — set the university name, centre lat/lng, zoom.
2. `VITE_MAP_CENTER` (`lat,lng`) + `VITE_MAP_ZOOM` env fallbacks.
3. Fallback midpoint of the campus locations supplied for Danfolio
   (`9.290626, 7.414310`, zoom 14).

If pins with coordinates exist, the map fits them first.

## 3. Configuring the routing provider

```env
# Routing SERVER ORIGIN — the standard OSRM route path is appended automatically
VITE_ROUTING_URL=https://router.project-osrm.org   # default (free demo)
```

The provider must speak the OSRM HTTP API:

```
GET <VITE_ROUTING_URL>/route/v1/driving/{lng},{lat};{lng},{lat}?overview=full&geometries=geojson
```

This covers the public demo server, a self-hosted OSRM instance, or a
compatible proxy. Logic lives in `src/lib/routing.js` (unit-tested).

Routes are re-requested only after the live origin moves **≥ 30 m**
(`REROUTE_MIN_MOVE_M`), so per-second GPS ticks don't hammer the provider.

> ⚠️ **The public OSRM demo server is rate-limited and has no SLA.** It is
> fine for development and controlled testing. For production, self-host
> OSRM (small VM/container) or buy a routing plan — ask before adding any
> paid service.

## 4. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `VITE_SUPABASE_URL` | ✅ | — | Supabase project |
| `VITE_SUPABASE_ANON_KEY` | ✅ | — | Publishable key (browser-safe) |
| `VITE_MAP_STYLE_URL` | — | OpenFreeMap `liberty` | Map style + tiles |
| `VITE_MAP_CENTER` | — | Danfolio campus midpoint | `lat,lng` fallback camera |
| `VITE_MAP_ZOOM` | — | `14` | Fallback zoom (1–20) |
| `VITE_ROUTING_URL` | — | `https://router.project-osrm.org` | OSRM server origin |
| `VITE_TRACK_MAX_ACCURACY_M` | — | `100` | Drop GPS fixes worse than this (metres) |
| `VITE_ARRIVAL_RADIUS_M` | — | `40` | "Nearby" hint radius (display only) |

Never put a service-role/secret key in any `VITE_` variable — Vite inlines
them into the public bundle. Edge Function secrets belong in
`supabase secrets set` (or Vault).

## 5. Supabase configuration

### Migration

`supabase/migrations/20261103100000_campus_map_live_tracking.sql` is
**additive only** (validated against the live schema inside a rolled-back
transaction on 2026-11-03; it was **not applied** — applying it is a
deliberate, separate step):

- `campus_settings` — single row (`id = 1`), all-nullable centre, read for
  signed-in users, write for admins (`is_admin()`).
- `ride_locations` — one **current** GPS row per ride
  (`ride_id` PK, `keke_id`, `lat`, `lng`, `accuracy`, `heading`, `speed`,
  `updated_at`), `updated_at` stamped by a DB trigger so freshness can't be
  forged by clients.
- RLS:
  - **read** — the ride's own student or assigned keke, *only while the ride
    is active* (`accepted/paid/arrived/on_trip`), plus admins. Access ends
    when the ride ends → location sharing stops by construction.
  - **write (insert/update)** — *only* the assigned keke of that ride, and
    only while it is active. Students have **no write policy at all**; other
    riders fail the `keke_id = auth.uid()` check.
  - **delete** — the assigned keke (own rows) or admins.
- Realtime: `ride_locations` added to the `supabase_realtime` publication so
  `postgres_changes` UPDATE events reach subscribers (RLS is applied per
  subscriber).

Apply with `supabase db push` (CLI, from this repo) or paste the file into
the SQL editor — **ask before running it against the live project.**

### Feature detection (important)

The frontend **probes** for the new tables:

- Missing table → student page falls back to the rider's existing `kekes`
  heartbeat and labels it honestly ("Rider position (heartbeat)"); the rider
  app shows "Live tracking is not enabled yet" with a Retry button.
- No error, no fake tracking: nothing ever fabricates coordinates.

### Existing tables reused (not duplicated)

- `locations` — unchanged; still the admin-managed point list (kind/mode/
  category/active), now edited through the map UI.
- `kekes.lat/lng/last_seen` — unchanged heartbeat; still drives the
  free-for-all keke markers and the dispatcher's 75 s freshness filter.
- `rides` and all ride state transitions/functions — **untouched**. Ride
  states never change because of GPS.

## 6. Adding campus locations

1. Sign in as admin → **Manage campus locations**.
2. Click the exact point on the map — latitude/longitude fill automatically
   (a "(not saved yet)" pin shows what you picked).
3. Enter **name**, pick **category** (suggestions: Main gate, Faculty,
   Lecture hall, Hostel, Library, Laboratory, Restaurant, Shop, Health
   centre, Keke stop, Other — or type your own), choose kind/mode.
4. **Add location**. Rows are stored in Supabase (`locations`), never
   hardcoded.
5. Edit via the table (or tap the pin), **Hide/Show** to activate/deactivate,
   **Delete** to remove. Deletion is refused politely if a fare or ride still
   references the point — hide it instead.
6. Search box + status/category filters narrow the list.

Campus name/centre: same page → **Campus settings** panel.

## 7. Adding missing campus road data

If a campus road/path is missing from OpenStreetMap, routing can't use it —
and we do **not** fake it. The map meanwhile shows the honest dashed direct
line. To fix the data properly:

1. Note the exact location (GPS coordinate or the map pin).
2. Edit OSM directly:
   - **iD editor** (browser): open [openstreetmap.org](https://www.openstreetmap.org),
     press Edit, draw the path (use the correct tags: `highway=service`,
     `highway=footway`, `highway=track`, etc.), add a note if unsure.
   - **JOSM** for larger surveys.
3. Or file a **OSM map note / changeset request** and let local mappers add it.
4. OSRM needs a **route snapshot refresh** to see new ways: the public demo
   server updates periodically (can take days); a self-hosted OSRM needs
   `osrm-extract/contract/route` re-run on the new planet/region extract.

Never add imaginary roads inside the app to make a route look complete.

## 8. Testing Keke live tracking (two devices)

Live GPS publishing has been **code-reviewed and unit-tested, but not yet
verified on real hardware** — run this before claiming it works.

**Setup — exact commands (both devices on the same Wi-Fi):**

```sh
npm run dev          # desktop/preview use → http://localhost:5173
npm run dev:https    # phones → https://localhost:5174 + https://<lan-ip>:5174
```

- `npm run dev:https` serves the dev server over **HTTPS**, which is
  **required for GPS**: browsers hard-block the Geolocation API on
  insecure origins (`http://<lan-ip>` fails with *"Only secure origins are
  allowed"* — the rider would never publish and the student would see
  "waiting for the rider's first position" forever).
- First run of `npm run dev:https` generates a self-signed **dev-only**
  certificate in `.cert/` using the system `openssl` (no new dependencies,
  git-ignored, never deployed). After changing Wi-Fi networks, regenerate
  it with `sh scripts/gen-dev-cert.sh --force` so the LAN IP in the
  certificate stays current.
- **Phone certificate steps:** Android Chrome → tap *Advanced* → *Proceed
  to this site*. iOS Safari → install the `.cert/dev-cert.pem` profile
  (AirDrop or serve it once), then *Settings → General → VPN & Device
  Management → Install*, and *Settings → General → About → Certificate
  Trust Settings → enable full trust*.
- **Allow the location prompt** on the rider phone (or site settings →
  Location → **Allow**). A previously denied origin stays denied until it
  is re-allowed in the browser's site settings.
- The OpenCode preview pane cannot open the self-signed HTTPS URL and
  auto-denies location prompts — run the GPS test from a normal browser
  or from the phones, not from the preview pane.

1. **Rider phone** — sign in as the keke rider, go online, accept a test
   booking (second phone/student account), pay it so the ride reaches
   `paid`. The rider app must show the tracking chip:
   `Starting live location…` → `Sharing live location · updated Xs ago`.
   - Deny the location prompt on purpose once: the chip must show the blocked
     state with **Retry**, and no coordinates should be written.
2. **Student phone** — open the ride page: keke marker should appear and
   move with real fixes; the freshness line shows
   `Live keke GPS · updated Xs ago`; the road line runs keke → pick-up with
   an ETA in minutes.
3. **Verify the writes** (Supabase dashboard → Table Editor →
   `ride_locations`, or theLogs): one row per ride, `updated_at` advancing,
   `accuracy` sane (< 100 m).
4. **Verify Realtime**: with the student page open, watch the marker move
   without refreshing.
5. **Verify stopping**: complete or cancel the ride → rider chip returns to
   idle, the row is deleted, and the student's location line disappears
   (RLS also hides finished rides).
6. **Negative tests**: an unrelated rider account must not be able to read
   or write another ride's row (RLS denies); students must have no write
   access (Supabase console → RLS simulators or a direct client write
   attempt that fails).

## 9. Known limitations & production considerations

- **Foreground-only GPS (v1).** `watchPosition()` runs while the rider's app
  tab is visible. A browser PWA cannot guarantee background tracking: when
  the OS suspends the tab, fixes pause and the student sees honest staleness
  (`updating slowly` / `location delayed`) until the app returns. Native
  background tracking would need a native wrapper — do not promise it.
- **Free OSRM demo / OpenFreeMap have no SLA** and rate limits — development
  and testing only (see §3).
- **Supabase Free plan limits** (connections, Realtime concurrent
  connections, row reads, DB size) apply to the whole app — check the
  current published limits before launch and ask before upgrading.
- **Arrival is proximity, never state.** "Nearby" banners are display-only
  (radius configurable via `VITE_ARRIVAL_RADIUS_M`, gated by fix freshness).
  Ride states move exclusively through the existing authorised server-side
  functions — no GPS-radius auto start/complete.
- **ETA honesty:** the ETA only appears with a real routed path; otherwise
  the UI says the road ETA is unavailable and retries. It refreshes after a
  ≥ 30 m origin move, not every fix.
- **Heartbeat fallback:** until `ride_locations` exists (or if a rider
  device stops publishing), the student page falls back to the coarser
  `kekes` heartbeat and says so in the freshness line.
- **HTTPS is a hard requirement for phone tracking** (see §8): over plain
  `http://<lan-ip>` every browser blocks geolocation, so the rider device
  publishes nothing and the student honestly sees "waiting for the rider's
  first position". Use `npm run dev:https` for any two-device test.
- **Attribution:** keep the OSM attribution visible — it is a legal
  requirement of the data licence.
