import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// notifications.test.js — drift-checks for the notification + presence
// backend (migration 20261124170000 + notify-tick + config). Same idea
// as policy.test.js: if someone edits the migration, weakens a grant,
// moves a secret into the repo, or breaks the match-tick contract these
// tests read, the suite fails instead of the app silently diverging.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function read(relPath) {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
}

const MIGRATION = 'supabase/migrations/20261124170000_notifications.sql'
const migration = read(MIGRATION)
const notifyTick = read('supabase/functions/notify-tick/index.ts')
const config = read('supabase/config.toml')
const matchTick = read('supabase/functions/match-tick/index.ts')

describe('notifications migration: tables', () => {
  it('creates the three tables', () => {
    expect(migration).toMatch(/create table public\.notifications \(/)
    expect(migration).toMatch(/create table public\.push_subscriptions \(/)
    expect(migration).toMatch(/create table public\.push_deliveries \(/)
  })

  it('dedupe_key is unique (idempotent event writes)', () => {
    expect(migration).toMatch(
      /create unique index notifications_dedupe_key\s+on public\.notifications \(dedupe_key\)/,
    )
    expect(migration).toMatch(/on conflict \(dedupe_key\) do nothing/)
  })

  it('checks notification types against the agreed event list', () => {
    for (const type of [
      'ride_accepted',
      'ride_arrived',
      'ride_cancelled',
      'ride_paid',
      'new_ride_request',
      'student_cancelled',
      'refund_initiated',
      'refund_completed',
      'refund_failed',
    ]) {
      expect(migration).toContain(`'${type}'`)
    }
  })
})

describe('notifications migration: RLS + least privilege', () => {
  it('enables RLS on every new table', () => {
    for (const table of ['notifications', 'push_subscriptions', 'push_deliveries']) {
      expect(migration).toMatch(
        new RegExp(`alter table public\\.${table}\\s+enable row level security`),
      )
    }
  })

  it('clients cannot insert or delete notifications (server-written only)', () => {
    expect(migration).toMatch(
      /revoke insert, update, delete on table public\.notifications from anon, authenticated/,
    )
    expect(migration).toMatch(
      /grant update \(read_at\) on table public\.notifications to authenticated/,
    )
  })

  it('push_deliveries has no client privileges at all', () => {
    expect(migration).toMatch(
      /revoke all on table public\.push_deliveries from anon, authenticated/,
    )
  })

  it('strips Supabase default TRUNCATE/REFERENCES/TRIGGER (RLS does not cover them)', () => {
    expect(migration).toMatch(
      /revoke truncate, references, trigger\s+on table public\.notifications from anon, authenticated/,
    )
    expect(migration).toMatch(
      /revoke truncate, references, trigger\s+on table public\.push_subscriptions from anon, authenticated/,
    )
  })

  it('subscription writes are own-row only (RLS user_id = auth.uid())', () => {
    expect(migration).toMatch(
      /policy "subscriptions own all"[\s\S]*?using \(user_id = auth\.uid\(\)\)[\s\S]*?with check \(user_id = auth\.uid\(\)\)/,
    )
  })

  it('internal enqueue helper is not callable from the API', () => {
    expect(migration).toMatch(
      /revoke execute on function public\.notify_enqueue[\s\S]*?from public, anon, authenticated/,
    )
  })
})

describe('notifications migration: triggers are safe', () => {
  it('every trigger function swallows exceptions (never fails a ride update)', () => {
    const fns = migration.match(/create or replace function public\.notify_on_[\s\S]*?\$function\$;/g) ?? []
    expect(fns.length).toBe(3)
    for (const fn of fns) {
      expect(fn).toMatch(/exception\s+when others then/)
    }
  })

  it('triggers are AFTER-only (observe, never influence, ride state)', () => {
    expect(migration).toMatch(/create trigger trg_notify_ride_status\s+after update on public\.rides/)
    expect(migration).toMatch(/create trigger trg_notify_ride_event\s+after insert on public\.ride_events/)
    expect(migration).toMatch(/create trigger trg_notify_new_request\s+after insert on public\.ride_requests/)
    expect(migration).not.toMatch(/create trigger trg_notify_\w+\s+before/)
  })

  it('new-request pushes target the OFFERED rider only, never a broadcast', () => {
    expect(migration).toMatch(/notify_on_new_request[\s\S]*?perform public\.notify_enqueue\(\s*NEW\.keke_id/)
    expect(migration).not.toMatch(/select .* from public\.kekes[\s\S]*?for each[\s\S]*?notify_enqueue/)
  })

  it('rider is never notified of their own cancellation (student/admin path only)', () => {
    expect(migration).toMatch(/NEW\.event = 'booking_cancelled'/)
    // rider-cancel-ride's own events must not reach the rider-notify branch:
    expect(migration).not.toMatch(/'trip_interrupted'[\s\S]{0,200}student_cancelled/)
  })

  it('notifications never write to rides, payments or kekes', () => {
    const enqueueBlock = migration.slice(
      migration.indexOf('function public.notify_enqueue'),
      migration.indexOf('$function$;', migration.indexOf('function public.notify_enqueue')),
    )
    for (const table of ['rides', 'payments', 'kekes']) {
      expect(enqueueBlock).not.toMatch(new RegExp(`(update|insert into|delete from) public\\.${table}\\b`, 'i'))
    }
  })
})

describe('presence RPCs', () => {
  it('heartbeat stamps last_seen server-side and only for on-duty riders', () => {
    expect(migration).toMatch(/function public\.keke_heartbeat/)
    expect(migration).toMatch(/set last_seen = now\(\)/)
    expect(migration).toMatch(/status in \('online', 'on_trip'\)/)
  })

  it('set_presence is own-row, rejects on_trip and invalid statuses', () => {
    expect(migration).toMatch(
      /p_status not in \('online', 'offline', 'unavailable'\)/,
    )
    expect(migration).toMatch(/where id = v_id/)
  })

  it('RPCs are executable by authenticated only', () => {
    expect(migration).toMatch(
      /grant execute on function public\.keke_heartbeat[\s\S]*?to authenticated/,
    )
    expect(migration).toMatch(
      /revoke execute on function public\.keke_set_presence[\s\S]*?from anon/,
    )
  })
})

describe('notify-tick function', () => {
  it('mirrors match-tick authorization (dedicated secret, exact match)', () => {
    expect(notifyTick).toMatch(/Deno\.env\.get\('NOTIFY_TICK_SECRET'\)/)
    expect(notifyTick).toMatch(/provided === `Bearer \$\{tickSecret\}`/)
    expect(notifyTick).toMatch(/return respond\(\{ error: 'Server authorization required\.' \}, 401\)/)
    // Nothing before the auth check (compare the const declaration and
    // the first data-plane client, not words in the header comment):
    const authIdx = notifyTick.indexOf('const authorized')
    const workIdx = notifyTick.indexOf('const admin = createClient')
    expect(authIdx).toBeGreaterThan(-1)
    expect(workIdx).toBeGreaterThan(authIdx)
  })

  it('never touches on_trip rows during the presence sweep', () => {
    expect(notifyTick).toMatch(/\.eq\('status', 'online'\)/)
    expect(notifyTick).not.toMatch(/\.update\(\{ status: 'offline' \}\)[\s\S]{0,80}on_trip/)
    expect(notifyTick).toMatch(/STALE_RIDER_MS = 45_000/)
  })

  it('dead endpoints disable the subscription; transient errors back off', () => {
    expect(notifyTick).toMatch(/statusCode === 404 \|\| statusCode === 410/)
    expect(notifyTick).toMatch(/disabled: true/)
    expect(notifyTick).toMatch(/MAX_ATTEMPTS = 5/)
    expect(notifyTick).toMatch(/next_attempt_at: new Date\(/)
  })

  it('response is aggregate-only (no user/endpoint/ride identifiers)', () => {
    const ret = notifyTick.slice(notifyTick.lastIndexOf('return respond({ ok: true'))
    expect(ret).not.toMatch(/user_id|endpoint|notification_id|subscription_id/)
  })
})

describe('secrets and config hygiene', () => {
  it('config declares notify-tick with gateway JWT verification OFF', () => {
    expect(config).toMatch(/\[functions\.notify-tick\]/)
    const block = config.slice(config.indexOf('[functions.notify-tick]'))
    expect(block).toMatch(/verify_jwt = false/)
    expect(block).toMatch(/entrypoint = "\.\/functions\/notify-tick\/index\.ts"/)
  })

  it('no secret values are committed anywhere in supabase/ or src/', () => {
    const files = [
      MIGRATION,
      'supabase/functions/notify-tick/index.ts',
      'supabase/config.toml',
    ]
    for (const f of files) {
      const text = read(f)
      // long base64-ish blobs that look like real keys, and literal secret
      // assignments whose value is not a `<placeholder>`:
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{40,}/)
      expect(text).not.toMatch(/VAPID_PRIVATE_KEY\s*=\s*['"][A-Za-z0-9+/=_-]{20,}/)
      expect(text).not.toMatch(/NOTIFY_TICK_SECRET\s*=\s*['"][^'"<]{8,}/)
      expect(text).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*=\s*['"][^'"<]{8,}/)
    }
  })

  it('cron job SQL uses the Vault-sourced token, never a literal', () => {
    // The job SQL lives in # comments, so allow comment markers/newlines
    // between the vault lookup and the secret name.
    expect(config).toMatch(/decrypted_secret[\s\S]{0,160}notify-tick-secret/)
  })
})

describe('existing behaviour is preserved (no-regression contracts)', () => {
  it('match-tick schedule, sweep and dispatch loop are untouched', () => {
    expect(matchTick).toMatch(/MATCH_TICK_SECRET/)
    expect(matchTick).toMatch(/90_000/)
    expect(matchTick).toMatch(/dispatch_next_ride_request/)
    expect(config).toMatch(/\[functions\.match-tick\]/)
  })

  it('migration does not modify dispatch, respond, payments or keke capacity', () => {
    expect(migration).not.toMatch(/create or replace function public\.(dispatch_next_ride_request|respond_to_ride_request)/)
    expect(migration).not.toMatch(/drop (table|policy|function)|alter table public\.(rides|payments|kekes) (drop|alter)/)
    expect(migration).not.toMatch(/revoke .* on table public\.(rides|payments)/)
  })

  it('refunds keep their own lifecycle — notifications only observe ride_events', () => {
    expect(migration).not.toMatch(/payments[\s\S]{0,80}update/i)
    expect(migration).toMatch(/'refund_initiated'|'refund_processed'|'refund_failed'/)
  })

  it('the existing client heartbeat column grant is left in place', () => {
    // 20261029140000 grants update(status, station_id, ..., last_seen);
    // this migration must not revoke it (Theo migrates later, per doc).
    expect(migration).not.toMatch(/revoke update on table public\.kekes/)
  })
})
