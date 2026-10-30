import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// complete-trip — rider finishes the trip they are physically on.
//
// Spec (PROJECT_SPEC.md, ride lifecycle + function table):
//   rides.status: searching -> accepted -> paid -> arrived -> on_trip -> completed
//   complete-trip (keke, ride_id): on_trip -> completed, completed_at,
//   keke status -> online.
//
// A ride must have reached 'on_trip' (via the spec's start-trip step) before
// it can be completed. Rides in accepted / paid / arrived are rejected with
// 409 and NO writes — completing early would close a trip that never started
// and could strand the student's payment state.
//
// Retry-safe (mirrors refund-ride): if the ride is already 'completed' the
// call still releases the rider (guarded on kekes.status = 'on_trip') and
// returns success, so a dropped response can never re-create the stuck-rider
// deadlock this function exists to fix.
//
// Auth: caller must be the ride's assigned rider (verified against the
// signed-in user from the JWT). Only the service-role client writes.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

async function releaseRider(
  admin: ReturnType<typeof createClient>,
  kekeId: string | null,
): Promise<boolean> {
  if (!kekeId) return true

  const { error } = await admin
    .from('kekes')
    .update({
      status: 'online',
      last_seen: new Date().toISOString(),
    })
    .eq('id', kekeId)
    .eq('status', 'on_trip')

  if (error) {
    console.error('Could not release rider after completion:', error)
    return false
  }

  return true
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed' }, 405)
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return respond({ error: 'Sign in is required.' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      console.error('Missing Supabase function environment configuration.')
      return respond({ error: 'Server configuration is incomplete.' }, 500)
    }

    // The caller must be a signed-in user. The service client below performs
    // the writes; clients never update ride or keke status directly.
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return respond({ error: 'Your session is invalid. Please sign in again.' }, 401)
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const body = await req.json().catch(() => null)
    const rideId = body?.ride_id

    if (
      typeof rideId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rideId)
    ) {
      return respond({ error: 'A valid ride ID is required.' }, 400)
    }

    const { data: ride, error: rideError } = await adminClient
      .from('rides')
      .select('id, keke_id, status')
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) throw rideError
    if (!ride) return respond({ error: 'Ride not found.' }, 404)

    if (ride.keke_id !== user.id) {
      return respond({
        error: 'Only the assigned Keke rider can complete this trip.',
      }, 403)
    }

    // Retry-safe: a completed ride must still release its rider, covering an
    // earlier attempt that updated the ride but failed before the release step.
    if (ride.status === 'completed') {
      const released = await releaseRider(adminClient, ride.keke_id)

      return respond({
        status: 'completed',
        ride_id: rideId,
        already_completed: true,
        rider_released: released,
      })
    }

    // Spec: only on_trip -> completed. Earlier states (accepted / paid /
    // arrived) are rejected with no writes.
    if (ride.status !== 'on_trip') {
      return respond({
        error:
          `Trips can only be completed while they are in progress. ` +
          `This ride's current status is "${ride.status}".`,
        status: ride.status,
      }, 409)
    }

    const { data: updatedRide, error: updateError } = await adminClient
      .from('rides')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
      })
      .eq('id', rideId)
      .eq('status', 'on_trip')
      .select('id, status')
      .maybeSingle()

    if (updateError) throw updateError

    if (!updatedRide) {
      return respond({
        error: 'The ride status changed. Please refresh and try again.',
      }, 409)
    }

    const released = await releaseRider(adminClient, ride.keke_id)

    return respond({
      status: 'completed',
      ride_id: rideId,
      rider_released: released,
      ...(released
        ? {}
        : {
            warning:
              'The trip is complete, but your rider status needs admin review.',
          }),
    })
  } catch (error) {
    console.error('complete-trip failed:', error)
    return respond({ error: 'Could not complete the trip. Please try again.' }, 500)
  }
})
