import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// match-tick — scheduled maintenance for the ride dispatcher.
//
// What it does (server-side safety net for ghosted offers and stale riders):
//
//   1. Expire overdue offers and rotate every 'searching' ride to the next
//      eligible rider by re-invoking the EXISTING dispatch_next_ride_request()
//      RPC. All dispatch rules (75s freshness filter, distance/queue/rating
//      ordering, cancellation when candidates are exhausted) live in that RPC
//      and are unchanged by this function. The RPC only runs when called, so
//      without this tick a never-answered offer was never rotated.
//
//   2. Flip 'online' riders whose heartbeat went stale (>90s) to 'offline' so
//      dashboards reflect reality. Only 'online' rows are ever touched:
//      'on_trip' riders do not heartbeat while driving and are never modified.
//      90s sits above the client's 20s heartbeat and the dispatcher's own 75s
//      freshness filter, so one dropped packet never flips a live rider.
//
// Scheduling (verified 2026-11 against Supabase docs/CLI/Management API):
//   Supabase Edge Functions have NO native scheduler — neither the CLI's
//   `functions deploy` (v2.122.0 has no --schedule flag) nor the Management
//   API exposes function schedules. The sanctioned scheduler is Supabase Cron
//   (pg_cron) calling this function through pg_net, with a DEDICATED random
//   secret stored in two places only — the function environment and Vault:
//
//     1. pg_cron + pg_net enabled on the project (CREATE EXTENSION via SQL
//        as `postgres`; the platform-managed `vault` schema provides
//        vault.create_secret / vault.decrypted_secrets even when the vault
//        extension itself is not in pg_available_extensions).
//     2. -- one-time: set the dedicated secret as an Edge Function secret
//        (never committed, never printed):
//          npx supabase secrets set MATCH_TICK_SECRET=<random value>
//     3. -- one-time: store the SAME value in Vault (never in job SQL, never
//        in the repo, and never the service-role key):
//        select vault.create_secret(
//          '<MATCH_TICK_SECRET value>', 'match-tick-secret',
//          'Dedicated scheduler token for the match-tick cron job');
//     4. select cron.schedule(
//          'match-tick',
//          '15 seconds',                -- sub-minute OK on PG >= 15.1.1.61
//                                        (this project runs PostgreSQL 17.11)
//          $$
//            select net.http_post(
//              url := 'https://<PROJECT_REF>.supabase.co/functions/v1/match-tick',
//              headers := jsonb_build_object(
//                'Content-Type', 'application/json',
//                'Authorization', 'Bearer ' || (
//                  select decrypted_secret from vault.decrypted_secrets
//                  where name = 'match-tick-secret')),
//              body := '{}'::jsonb,
//              timeout_milliseconds := 10000
//            );
//          $$
//        );
//      Rotate with vault.update_secret + `supabase secrets set` — the job
//      SQL never changes.
//
// Authorization (two layers, one header):
//   Layer 1 — gateway: match-tick is deployed with verify_jwt = false
//     (config.toml) because the cron bearer is a dedicated random token, not
//     a project JWT. This matches the create-ride pattern: the gateway step
//     is skipped and the function itself enforces a constant-time-ish exact
//     match, so a valid-but-wrong JWT (e.g. the public anon key) is rejected
//     here with 401.
//   Layer 2 — this function: the Authorization header must exactly equal
//     `Bearer <MATCH_TICK_SECRET>` from its own environment. The dedicated
//     secret (not the service-role key) authorizes the tick; the service key
//     is only used as the data-plane client after the check passes. A
//     secondary exact-match against SUPABASE_SERVICE_ROLE_KEY is kept so
//     operators can still health-check manually with the server key.
//   Nothing in the function runs before the check completes, and the cron
//   job SQL contains only the Vault-sourced dedicated token.

Deno.serve(async (req) => {
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  // The pg_net cron job invokes with POST; GET is accepted for manual health
  // checks. Both pass through the same authorization below.
  if (req.method !== 'GET' && req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405)
  }

  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const matchSecret = Deno.env.get('MATCH_TICK_SECRET')
    const provided = req.headers.get('Authorization')

    // Only the scheduler (holding the dedicated secret) or an operator
    // (holding the service key, for manual health checks) may tick.
    const authorized =
      (Boolean(matchSecret) && provided === `Bearer ${matchSecret}`) ||
      (Boolean(serviceKey) && provided === `Bearer ${serviceKey}`)

    if (!authorized) {
      return respond({ error: 'Server authorization required.' }, 401)
    }

    if (!supabaseUrl || !serviceKey) {
      console.error('match-tick: missing environment configuration.')
      return respond({ error: 'Server configuration is incomplete.' }, 500)
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // 1. Stale-rider sweep (reporting hygiene only; dispatch already excludes
    //    stale riders via its own last_seen >= now() - 75s filter). Touches
    //    ONLY 'online' rows — never 'on_trip'.
    const { data: swept, error: sweepError } = await admin
      .from('kekes')
      .update({ status: 'offline' })
      .eq('status', 'online')
      .lt('last_seen', new Date(Date.now() - 90_000).toISOString())
      .select('id')

    if (sweepError) throw sweepError

    // 2. Re-dispatch every ride still searching. The RPC expires overdue
    //    offers, rotates to the next eligible rider, and cancels the ride
    //    when candidates are exhausted — all unchanged existing behaviour.
    const { data: searching, error: searchError } = await admin
      .from('rides')
      .select('id')
      .eq('status', 'searching')

    if (searchError) throw searchError

    let dispatched = 0

    for (const { id } of searching ?? []) {
      const { error } = await admin.rpc('dispatch_next_ride_request', {
        p_ride_id: id,
      })

      if (error) {
        // One bad ride must not stop the rest of the tick.
        console.error(`match-tick: dispatch failed for ride ${id}:`, error.message)
      } else {
        dispatched += 1
      }
    }

    // Aggregate counts only — no ride IDs or rider states in the response.
    return respond({
      ok: true,
      swept_stale_riders: swept?.length ?? 0,
      dispatched_rides: dispatched,
    })
  } catch (error) {
    console.error('match-tick failed:', error)
    return respond({ error: 'Match tick failed.' }, 500)
  }
})
