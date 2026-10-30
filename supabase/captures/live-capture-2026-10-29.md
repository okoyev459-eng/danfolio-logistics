# Live database capture — 2026-10-29 (v2, verified)

**This is a REFERENCE DOCUMENT. It is not a migration. Do not apply it to the database.**

Located in `supabase/captures/`, not `supabase/migrations/`, so the Supabase CLI will never
execute it.

## How this was captured

v1 of this file was written from the **anon key** using error-message probing, and marked four
items as "NOT CAPTURED". Those four are now captured.

- **Connection:** read-only, via the Supabase Postgres pooler (`aws-0-eu-west-1.pooler.supabase.com:5432`)
- **Session safety:** `SET default_transaction_read_only = on` — the *database* rejects any write,
  DDL or sequence change. Not a convention, an enforcement.
- **Note:** there is no direct-connection host. `db.aulehukobsttuzzmcyqh.supabase.co` returns no
  DNS answer at all; the pooler is the only route.
- **TLS:** Supabase's pooler uses Supabase's *own* private PKI (`Supabase Root 2021 CA`), which is
  not in Node's public trust store. That one root CA is **pinned by SHA-256 fingerprint** in the
  helper — full chain and hostname verification is preserved. `rejectUnauthorized: false` was
  deliberately *not* used, because it would discard hostname checking as well.

### Backups taken before anything else

| File | Contents |
|---|---|
| `backup-2026-10-29T09-29-40-827Z.sql` | 6 functions, 1 trigger, 20 policies, 10 RLS tables, 40 constraints (17.7 KB) |
| `backup-data.sql` | 58 rows across all 10 tables (11.2 KB) |

Both live outside the repo, in the session temp directory.

---

## 1. Functions — 6 in `public`

| Function | Signature | Language | Security |
|---|---|---|---|
| `dispatch_next_ride_request` | `(p_ride_id uuid) → jsonb` | plpgsql | **DEFINER** |
| `respond_to_ride_request` | `(p_request_id uuid, p_response request_response) → jsonb` | plpgsql | **DEFINER** |
| `handle_new_user` | `() → trigger` | plpgsql | DEFINER |
| `is_admin` | `() → boolean` | sql | DEFINER |
| `is_keke` | `() → boolean` | sql | DEFINER |
| `lock_keke_number` | `() → trigger` | plpgsql | — |

EXECUTE grants: `anon` = **false**, `authenticated` = **true**, `service_role` = **true** for both
RPCs. This is why the anon key got `permission denied` in v1 — correct posture, not a bug.

Both dispatch functions run `SET search_path TO ''` and qualify every object with `pg_catalog.` or
`public.` — good hardening against search-path hijacking. Both take `pg_advisory_xact_lock`.

---

## 2. `dispatch_next_ride_request` — what it ACTUALLY does

**Three findings that contradict spec §5:**

### 2a. Stale-rider filtering ALREADY EXISTS (spec does not mention it)

```sql
WHERE k.status = 'online'
  AND k.last_seen >= pg_catalog.clock_timestamp() - interval '75 seconds'
```

The dispatch query already excludes riders whose `last_seen` is older than **75 seconds**. So a
rider who closes the app or loses signal **cannot be offered a ride** — the freshness check is
inside the selection query itself, not merely client-side.

This substantially changes the earlier audit: the "phantom rider absorbs the offer" failure mode is
already prevented *at dispatch time*. What is **not** handled is that the row is never flipped back
to `offline` — a hygiene/reporting problem, not a dispatch problem.

### 2b. Expiry is already done — but only when dispatch runs

```sql
UPDATE public.ride_requests
SET response = 'expired'
WHERE response = 'pending' AND expires_at <= pg_catalog.clock_timestamp();
```

Offer expiry exists inside this function. The gap is that **nothing calls the function on a
schedule**. It is called only:
- once by `create-ride` at booking time
- from inside `respond_to_ride_request` when a rider responds

If a rider closes the app mid-offer and never responds, **no one calls dispatch again**, so the
offer is never rotated. That is the real server-side expiry gap.

### 2c. There is no "4 attempts" rule — spec §5 is wrong about this

Spec §5 says *"after 4 expired/declined, set ride `cancelled`"*. The actual function has **no
attempt counter**. Instead, when the candidate loop finds nobody eligible it cancels:

```sql
UPDATE public.rides SET status = 'cancelled'
WHERE id = p_ride_id AND status = 'searching' AND keke_id IS NULL;
RETURN jsonb_build_object('state', 'no_ride_available');
```

Cancellation happens when **eligible candidates are exhausted**, not after a fixed count of 4.
Since each rider can be asked at most once per ride (`NOT EXISTS previous.ride_id = p_ride_id`),
the effective attempt limit is *the number of eligible riders*, not 4.

### 2d. Ordering — actual, verified

```sql
ORDER BY
  CASE WHEN pickup coords available AND rider/station coords available
       THEN haversine_metres(...) END ASC NULLS LAST,   -- distance, metres
  k.queue_joined_at ASC NULLS LAST,
  k.rating DESC NULLS LAST,
  k.id
```

Rider coordinates fall back to station coordinates: `COALESCE(k.lat, station.lat)`.

**Spec §5 says Along filters on `station_id = ride.from_id`. The code does not.** There is no
station filter at all — `LEFT JOIN locations station` is used *only* to borrow coordinates. Any
online, fresh, not-yet-asked rider is a candidate for both modes.

**And in the live data this ordering is inert:** every one of the 15 `locations` rows has
`lat = NULL, lng = NULL`, and all 3 `kekes` rows have `lat = NULL, lng = NULL`,
`queue_joined_at = NULL`, `station_id = NULL`. So:
- distance → `NULL` for everyone → `NULLS LAST`, all equal
- `queue_joined_at` → `NULL` for everyone → all equal
- `rating` → `5.0` for everyone → all equal
- **`k.id` is the only effective tiebreaker → selection is effectively random UUID order**

The dispatch ordering rules are *present and correct in code* but have **nothing to order on**.

---

## 3. `respond_to_ride_request` — verified behaviour

- Requires `auth.uid()`; rejects responses outside `('accepted','declined','expired')`
- Verifies the offer belongs to the calling rider
- Idempotent: if `response <> 'pending'` it returns the existing state and changes nothing
- On **accept after deadline**: marks the offer expired and re-dispatches instead of accepting
- On **accept before deadline**: sets `rides.keke_id`, `status='accepted'`, `accepted_at`, sets the
  offer `accepted`, **and sets `kekes.status='on_trip'` with a fresh `last_seen`**
- On **`expired` before the deadline**: refuses, returns `{state:'pending'}` — *"a timeout cannot be
  declared before the server deadline"*
- On decline or genuine expiry: writes the final response, then **immediately re-dispatches**

So the BUSY transition *is* handled server-side on accept. Confirmed.

---

## 4. What still releases a rider: only `refund-ride`

`on_trip → online` is written by exactly one place: the `refund-ride` Edge Function
(`refund-ride/index.ts:198-217`), guarded by `.eq('status','on_trip')`.

There is no `complete-trip`, no `cancel-ride`, no `accept-ride`, no `mark-arrived`, no `start-trip`,
no `match_tick` — all confirmed absent.

**Live proof of the deadlock:** keke `KEKE 214 UNI` has been `status='on_trip'` since
**2026-10-27T08:15:13Z** — stuck for two days, with `last_seen` frozen at the same moment. Nothing
can free it. This is the bug, happening right now in your data.

---

## 5. RLS — 20 policies, RLS enabled on all 10 tables

### `kekes`
| Policy | Cmd | Rule |
|---|---|---|
| `kekes read` | SELECT | own row, or admin, or a student who has a ride with this keke |
| `kekes update` | UPDATE | `id = auth.uid() OR is_admin()` |
| `kekes insert` | INSERT | `is_admin()` |

No `WITH CHECK` on update → a rider may set **any column** on their own row, including `status`,
`station_id`, `queue_joined_at`. This matches spec §4's write rules.

### `rides`
| Policy | Cmd | Rule |
|---|---|---|
| `rides create` | INSERT | `student_id = auth.uid() AND status = 'searching'` |
| `rides read` | SELECT | own, assigned-to-me, admin, or (`searching` AND `keke_id IS NULL` AND is_keke) |

**There is NO UPDATE policy and NO DELETE policy on `rides`.** Zero of each — verified by count.

This means `src/pages/keke/Request.jsx:56-63` (direct `update rides set keke_id=..., status=...`)
**cannot succeed** — RLS silently updates 0 rows, and the component shows its "already taken, or
permissions blocked" message. It is dead code that fails safe, not a landmine. It still violates
spec §4 in intent and should be removed, but it is not a live corruption risk.

### `ride_requests`
| Policy | Cmd | Rule |
|---|---|---|
| `requests read` | SELECT | `keke_id = auth.uid()` or admin |
| `requests respond` | UPDATE | `keke_id = auth.uid()` |

No `WITH CHECK` → a rider could write any `response` value directly, including `'accepted'`,
bypassing `respond_to_ride_request`. **Spec §5 says ACCEPT must call the RPC, not edit
`response` — but RLS does not enforce that.** The UI honours it; the database does not.

### Others
- `fares`, `locations`: read-all for authenticated; write `is_admin()` only
- `profiles`: read own/admin/participants; write admin only
- `payments`, `tickets`: read via own ride only; **no write policies at all** (Edge Functions only) ✓
- `reports`, `reviews`: insert own, read own/admin; reports update admin only ✓
- Trigger `keke_number_locked` blocks `keke_number` changes (matches spec: immutable) ✓

---

## 6. Schema facts

- **All 10 spec tables**, RLS enabled on all 10, **no extra tables**
- **Enums:** `keke_status` = `offline|online|on_trip` (**no `unavailable`**) · `ride_status` = all 8
  spec values · `request_response` = `pending|accepted|declined|expired` · `ride_mode` = `drop|along`
  · `location_kind` · `user_role` = `student|keke|admin`
- `payments.status`, `tickets.status`, `reports.status` are **plain text with CHECK constraints**,
  not enums
- **`ride_requests` has no attempt counter** — columns are exactly
  `id, ride_id, keke_id, sent_at, expires_at, response`
- Defaults: `kekes.status` = `'offline'` · `rides.status` = `'searching'` ·
  `ride_requests.response` = `'pending'` · `expires_at` = `now() + 15s` ·
  `booking_code` = `lpad(floor(random()*10000), 4, '0')`
- `kekes.rating` default `5.0`, NOT NULL
- FKs: `kekes.id → profiles.id ON DELETE CASCADE`; `ride_requests.ride_id → rides.id ON DELETE CASCADE`

## 7. Cron and realtime

- **`pg_cron` is NOT installed.** It *is* available (`pg_available_extensions` shows 1.6.4), but the
  connected role is **not superuser** (`rolsuper = false`), so `CREATE EXTENSION pg_cron` will very
  likely fail. `pg_net` (0.20.4) is also available and unused.
- **Realtime is enabled on exactly the three spec tables:** `kekes`, `rides`, `ride_requests`. ✓
- No client subscribes to `kekes` — only `ride_requests` (rider) and `rides` (student).

## 8. Live data (58 rows)

| Table | Rows | Note |
|---|---|---|
| `locations` | 15 | **all `lat`/`lng` NULL** |
| `fares` | 25 | |
| `profiles` | 5 | |
| `kekes` | 3 | 2× `offline` (never seen), 1× **stuck `on_trip` since 27 Oct** |
| `rides` | 6 | |
| `ride_requests` | 3 | |

Every `kekes` row has `station_id`, `queue_joined_at`, `lat`, `lng` all **NULL** — so Along
station-matching and queue ordering have no data to work with, and the admin has no UI to set
`station_id`.

---

## 9. Consequences for the plan (v1 → v2)

| v1 claim | v2 reality |
|---|---|
| Dispatch does not filter stale riders | **It does** — `last_seen >= now() - 75s`, in the query |
| Server-side offer expiry missing entirely | Expiry logic exists; **nothing invokes it on a schedule** |
| Need a 4-attempt counter (new column) | **No** — cancellation is by candidate exhaustion; no column needed |
| Need a sweep to remove phantom riders from dispatch | Not needed for dispatch; still useful to flip rows to `offline` for reporting |
| Ordering must be carefully preserved | Ordering is correct but **inert** — no coordinates or queue data exist |
| `Request.jsx` is a dangerous live path | **Fails safe** — `rides` has no UPDATE policy, 0 rows updated |

**Net: the fix is smaller than v1 proposed.** No new column, no attempt counter, no ordering change.
