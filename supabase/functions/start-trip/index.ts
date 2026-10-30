import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// start-trip — rider verifies boarding and starts the trip.
//
// Spec (PROJECT_SPEC.md function table):
//   start-trip (keke, ride_id, booking_code): ride `arrived`, code matches,
//   ticket `unused`: ride `on_trip`, ticket `used`. Returns { status }.
//
// Boarding verification is server-side: the rider types the 4-digit booking
// code the student is showing on the "Show keke I booked" screen. The code is
// validated against the ride's own booking_code, the ride must be 'arrived'
// and assigned to this rider, and the ticket must still be 'unused' — a used
// ticket can never be replayed (its update is guarded on status='unused').
//
// Retry-safe ordering: the ride moves to 'on_trip' first (guarded), then the
// ticket is marked used (guarded). If the response is dropped between the two
// writes, a retry finds the ride already 'on_trip' with the ticket still
// 'unused' and finishes the ticket step instead of failing.
//
// Auth: caller must be a signed-in keke (role checked server-side). Only the
// service-role client writes.

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
    const bookingCode = typeof body?.booking_code === 'string'
      ? body.booking_code.trim()
      : ''

    if (typeof rideId !== 'string' || !UUID_RE.test(rideId)) {
      return respond({ error: 'A valid ride ID is required.' }, 400)
    }

    if (!/^\d{4}$/.test(bookingCode)) {
      return respond({ error: 'Enter the 4-digit booking code shown by the student.' }, 400)
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: ride, error: rideError } = await adminClient
      .from('rides')
      .select('id, keke_id, status, booking_code')
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) throw rideError
    if (!ride) return respond({ error: 'Ride not found.' }, 404)

    if (ride.keke_id !== user.id) {
      return respond({
        error: 'Only the assigned Keke rider can start this trip.',
      }, 403)
    }

    // The boarding code must match this ride's code (compare as text).
    if (String(ride.booking_code).padStart(4, '0') !== bookingCode) {
      return respond({
        error: 'That booking code does not match this ride. Ask the student to show the code again.',
      }, 403)
    }

    // The ride must have reached 'arrived' (the student has paid and the
    // rider has arrived) before the trip can start.
    if (ride.status !== 'arrived' && ride.status !== 'on_trip') {
      return respond({
        error:
          `Trips can only be started when the ride is ready for boarding. ` +
          `This ride's current status is "${ride.status}".`,
        status: ride.status,
      }, 409)
    }

    // Move the ride to 'on_trip' when it is not there yet (guarded update).
    if (ride.status === 'arrived') {
      const { data: updated, error: updateError } = await adminClient
        .from('rides')
        .update({ status: 'on_trip' })
        .eq('id', rideId)
        .eq('status', 'arrived')
        .select('id, status')
        .maybeSingle()

      if (updateError) throw updateError

      if (!updated) {
        return respond({
          error: 'The ride status changed. Please refresh and try again.',
        }, 409)
      }
    }

    // Use the ticket (guarded on 'unused' so it can never be replayed).
    const { data: ticket, error: ticketError } = await adminClient
      .from('tickets')
      .update({ status: 'used' })
      .eq('ride_id', rideId)
      .eq('status', 'unused')
      .select('id, ticket_no, status')
      .maybeSingle()

    if (ticketError) throw ticketError

    return respond({
      status: 'on_trip',
      ride_id: rideId,
      ticket_used: Boolean(ticket),
    })
  } catch (error) {
    console.error('start-trip failed:', error)
    return respond({ error: 'Could not start the trip. Please try again.' }, 500)
  }
})
