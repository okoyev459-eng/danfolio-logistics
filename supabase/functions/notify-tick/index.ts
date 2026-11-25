import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import webPush from 'npm:web-push@3.6.7'

// notify-tick — scheduled delivery of Web Push notifications + stale
// rider expiry. Companion to match-tick; it NEVER touches ride state.
//
// What it does (aggregate counts only in the response):
//
//   1. Presence expiry: flip 'online' riders whose heartbeat went stale
//      (>45s) to 'offline'. ONLY 'online' rows are ever touched —
//      'on_trip' riders keep their state (same rule as match-tick's 90s
//      reporting sweep, but tighter, so offline riders leave the dispatch
//      pool promptly). Dispatch itself already excludes stale riders via
//      its own last_seen >= now()-75s filter, so an expired rider can not
//      receive an offer even between two ticks.
//
//   2. Deliver pending push_deliveries due now (attempts < 5), using the
//      VAPID key pair from the function environment (never from the DB,
//      never committed). Outcomes:
//        2xx            -> status 'sent', sent_at = now();
//        404 / 410      -> subscription is dead: disabled = true and the
//                          delivery fails permanently (no more retries);
//        other errors   -> attempts += 1, exponential-ish backoff
//                          (30s * attempts) via next_attempt_at;
//        5th failure    -> status 'failed' (kept for diagnosis).
//      A dead subscription never blocks the queue: it is disabled and
//      skipped on subsequent ticks.
//
// Scheduling (identical sanctioned pattern as match-tick — see
// config.toml [functions.notify-tick] for the one-time setup SQL):
//   pg_cron + pg_net call this function every 15 seconds with a DEDICATED
//   random secret (NOTIFY_TICK_SECRET) stored in the function environment
//   and Vault ('notify-tick-secret'). The service-role key is only the
//   data-plane client after the check passes.
//
// Authorization (two layers, one header — same as match-tick):
//   Layer 1 — gateway: verify_jwt = false in config.toml because the cron
//     bearer is a dedicated token, not a project JWT.
//   Layer 2 — this function: Authorization must exactly equal
//     `Bearer <NOTIFY_TICK_SECRET>`, or `Bearer <service key>` for an
//     operator health check. Nothing runs before the check completes.
//
// Notifications themselves are created by database triggers (see
// migration 20261124170000_notifications.sql); this function only moves
// rows from 'pending' to 'sent' / 'failed' and expires stale riders.

const MAX_ATTEMPTS = 5
const BACKOFF_BASE_MS = 30_000
const STALE_RIDER_MS = 45_000
const BATCH_LIMIT = 100

Deno.serve(async (req) => {
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })

  if (req.method !== 'GET' && req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405)
  }

  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const tickSecret = Deno.env.get('NOTIFY_TICK_SECRET')
    const provided = req.headers.get('Authorization')

    const authorized =
      (Boolean(tickSecret) && provided === `Bearer ${tickSecret}`) ||
      (Boolean(serviceKey) && provided === `Bearer ${serviceKey}`)

    if (!authorized) {
      return respond({ error: 'Server authorization required.' }, 401)
    }

    if (!supabaseUrl || !serviceKey) {
      console.error('notify-tick: missing environment configuration.')
      return respond({ error: 'Server configuration is incomplete.' }, 500)
    }

    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    // 1. Stale-rider expiry (reporting + dispatch-pool hygiene).
    //    Touches ONLY 'online' — never 'on_trip', never 'unavailable'.
    const { data: swept, error: sweepError } = await admin
      .from('kekes')
      .update({ status: 'offline' })
      .eq('status', 'online')
      .lt('last_seen', new Date(Date.now() - STALE_RIDER_MS).toISOString())
      .select('id')

    if (sweepError) throw sweepError

    // 2. Deliver due pushes.
    const vapidPublicKey = Deno.env.get('VAPID_PUBLIC_KEY')
    const vapidPrivateKey = Deno.env.get('VAPID_PRIVATE_KEY')
    const vapidSubject = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@danfolio.local'

    let delivered = 0
    let retried = 0
    let failed = 0
    let disabled = 0

    if (vapidPublicKey && vapidPrivateKey) {
      webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey)

      const nowIso = new Date().toISOString()
      const { data: due, error: dueError } = await admin
        .from('push_deliveries')
        .select('id, attempts, notification_id, subscription_id')
        .eq('status', 'pending')
        .lte('next_attempt_at', nowIso)
        .lt('attempts', MAX_ATTEMPTS)
        .limit(BATCH_LIMIT)

      if (dueError) throw dueError

      for (const row of due ?? []) {
        const [sub, notif] = await Promise.all([
          admin
            .from('push_subscriptions')
            .select('endpoint, p256dh, auth, disabled')
            .eq('id', row.subscription_id)
            .maybeSingle(),
          admin
            .from('notifications')
            .select('title, body, type, data, ride_id')
            .eq('id', row.notification_id)
            .maybeSingle(),
        ])

        const subscription = sub.data
        const notification = notif.data

        if (!subscription || subscription.disabled || !notification) {
          // Subscription vanished or was disabled between reads.
          await admin
            .from('push_deliveries')
            .update({ status: 'failed', last_error: 'subscription_gone' })
            .eq('id', row.id)
          failed += 1
          continue
        }

        try {
          await webPush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            JSON.stringify({
              title: notification.title,
              body: notification.body,
              type: notification.type,
              ride_id: notification.ride_id,
              data: notification.data ?? {},
            }),
            { TTL: 300, urgency: 'normal' },
          )

          await admin
            .from('push_deliveries')
            .update({ status: 'sent', sent_at: new Date().toISOString() })
            .eq('id', row.id)

          await admin
            .from('push_subscriptions')
            .update({ last_seen_at: new Date().toISOString() })
            .eq('id', row.subscription_id)

          delivered += 1
        } catch (pushError) {
          const statusCode = (pushError as { statusCode?: number }).statusCode
          const message =
            (pushError as { body?: string }).body ??
            (pushError as { message?: string }).message ??
            'push_error'

          if (statusCode === 404 || statusCode === 410) {
            // Endpoint is permanently dead (browser unsubscribed / expired).
            await admin
              .from('push_subscriptions')
              .update({ disabled: true })
              .eq('id', row.subscription_id)
            await admin
              .from('push_deliveries')
              .update({
                status: 'failed',
                last_error: `endpoint_${statusCode}`,
              })
              .eq('id', row.id)
            disabled += 1
          } else {
            const attempts = row.attempts + 1
            const exhausted = attempts >= MAX_ATTEMPTS
            await admin
              .from('push_deliveries')
              .update({
                attempts,
                status: exhausted ? 'failed' : 'pending',
                last_error: String(message).slice(0, 500),
                next_attempt_at: new Date(
                  Date.now() + BACKOFF_BASE_MS * attempts,
                ).toISOString(),
              })
              .eq('id', row.id)
            if (exhausted) failed += 1
            else retried += 1
          }
        }
      }
    }
    // No VAPID keys configured: skip delivery silently but keep the
    // presence sweep running (queue stays pending until keys are set).

    // Aggregate counts only — no user ids, endpoints or ride ids.
    return respond({
      ok: true,
      expired_riders: swept?.length ?? 0,
      delivered,
      retried,
      failed,
      subscriptions_disabled: disabled,
      vapid_configured: Boolean(vapidPublicKey && vapidPrivateKey),
    })
  } catch (error) {
    // Operator-only surface (behind the dedicated token / service key):
    // the message makes a failed tick diagnosable without dashboard logs.
    console.error('notify-tick failed:', error)
    return respond({
      error: 'Notify tick failed.',
      detail: error instanceof Error
        ? error.message
        : JSON.stringify(error)?.slice(0, 500) ?? String(error),
    }, 500)
  }
})
