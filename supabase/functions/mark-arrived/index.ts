import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// mark-arrived — rider confirms they have reached the student.
//
// Spec (PROJECT_SPEC.md function table):
//   mark-arrived (keke, ride_id): paid -> arrived. Returns { status }.
//
// The rider must be the ride's assigned keke, and the ride must be in 'paid'
// (student has paid; rider is heading to pickup). Arrived / on_trip are
// accepted as idempotent success so a dropped response can be retried safely;
// every other state is a 409 with no writes.
//
// Auth: caller must be a signed-in keke (role checked server-side). Only the
// service-role client writes — clients never update ride status directly.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return respond({ error: 'Your session is invalid. Please sign in again.' }, 401)
    }

    const { data: profile, error: profileError } = await userClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) throw profileError
    if (profile?.role !== 'keke') {
      return respond({ error: 'Only Keke rider accounts can use this function.' }, 403)
    }

    const body = await req.json().catch(() => null)
    const rideId = body?.ride_id

    if (typeof rideId !== 'string' || !UUID_RE.test(rideId)) {
      return respond({ error: 'A valid ride ID is required.' }, 400)
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: ride, error: rideError } = await adminClient
      .from('rides')
      .select('id, keke_id, status')
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) throw rideError
    if (!ride) return respond({ error: 'Ride not found.' }, 404)

    if (ride.keke_id !== user.id) {
      return respond({
        error: 'Only the assigned Keke rider can update this ride.',
      }, 403)
    }

    // Retry-safe: an already-arrived (or moving) trip reports success.
    if (ride.status === 'arrived' || ride.status === 'on_trip') {
      return respond({
        status: ride.status,
        ride_id: rideId,
        already_arrived: true,
      })
    }

    if (ride.status !== 'paid') {
      return respond({
        error:
          `Arrival can only be recorded after the student has paid. ` +
          `This ride's current status is "${ride.status}".`,
        status: ride.status,
      }, 409)
    }

    const { data: updated, error: updateError } = await adminClient
      .from('rides')
      .update({ status: 'arrived' })
      .eq('id', rideId)
      .eq('status', 'paid')
      .select('id, status')
      .maybeSingle()

    if (updateError) throw updateError

    if (!updated) {
      return respond({
        error: 'The ride status changed. Please refresh and try again.',
      }, 409)
    }

    return respond({ status: 'arrived', ride_id: rideId })
  } catch (error) {
    console.error('mark-arrived failed:', error)
    return respond({ error: 'Could not record arrival. Please try again.' }, 500)
  }
})
