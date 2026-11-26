import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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

    const { data: profile, error: profileError } = await adminClient
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (profileError) throw profileError
    if (profile?.role !== 'student') {
      return respond({ error: 'Only student accounts can book rides.' }, 403)
    }

    const body = await req.json()
    const { mode, from_id, to_id } = body ?? {}

    if (
      !['drop', 'along'].includes(mode) ||
      typeof from_id !== 'string' ||
      typeof to_id !== 'string' ||
      from_id === to_id
    ) {
      return respond({ error: 'Please select a valid route.' }, 400)
    }

    const { data: fromLocation, error: fromError } = await adminClient
      .from('locations')
      .select('id, name, mode, active')
      .eq('id', from_id)
      .maybeSingle()

    if (fromError) throw fromError

    const { data: toLocation, error: toError } = await adminClient
      .from('locations')
      .select('id, name, mode, active')
      .eq('id', to_id)
      .maybeSingle()

    if (toError) throw toError

    // One place list: any active place in the ride's mode can start or end a
    // trip. `kind` used to be required here (pickup/station → destination),
    // which forced the admin to enter every place twice and made the fare
    // lists look split; the pickers and fares now share one place list, so
    // the only rule is that the two ends are different places.
    const samePlace =
      Boolean(fromLocation && toLocation) &&
      String(fromLocation.name).trim().toLowerCase() ===
        String(toLocation.name).trim().toLowerCase()

    if (
      !fromLocation || !toLocation ||
      !fromLocation.active || !toLocation.active ||
      fromLocation.mode !== mode || toLocation.mode !== mode ||
      samePlace
    ) {
      return respond({ error: 'This route is unavailable.' }, 400)
    }

    const { data: fareRow, error: fareError } = await adminClient
      .from('fares')
      .select('amount')
      .eq('mode', mode)
      .eq('from_id', from_id)
      .eq('to_id', to_id)
      .maybeSingle()

    if (fareError) throw fareError
    if (!fareRow || !Number.isSafeInteger(fareRow.amount) || fareRow.amount <= 0) {
      return respond({ error: 'No valid fare is configured for this route.' }, 400)
    }

    const { data: activeRide, error: activeRideError } = await adminClient
      .from('rides')
      .select('id')
      .eq('student_id', user.id)
      .in('status', ['searching', 'accepted', 'paid', 'arrived', 'on_trip'])
      .limit(1)
      .maybeSingle()

    if (activeRideError) throw activeRideError
    if (activeRide) {
      return respond({ error: 'You already have an active ride.', ride_id: activeRide.id }, 409)
    }

    const { data: ride, error: rideError } = await adminClient
      .from('rides')
      .insert({
        student_id: user.id,
        mode,
        from_id,
        to_id,
        fare: fareRow.amount,
        status: 'searching',
      })
      .select('id, fare, status')
      .single()

    if (rideError) {
      // Partial unique index rides_one_active_per_student: two bookings for
      // the same student can never both land, even when they race.
      if (rideError.code === '23505') {
        const { data: activeRide } = await adminClient
          .from('rides')
          .select('id')
          .eq('student_id', user.id)
          .in('status', ['searching', 'accepted', 'paid', 'arrived', 'on_trip'])
          .limit(1)
          .maybeSingle()

        return respond({
          error: 'You already have an active ride.',
          ride_id: activeRide?.id ?? null,
        }, 409)
      }
      throw rideError
    }

    const { data: dispatch, error: dispatchError } = await adminClient.rpc(
      'dispatch_next_ride_request',
      { p_ride_id: ride.id },
    )

    if (dispatchError) throw dispatchError

    return respond({
      ride_id: ride.id,
      fare: ride.fare,
      status: dispatch?.state === 'no_ride_available' ? 'cancelled' : ride.status,
      dispatch_state: dispatch?.state ?? 'pending',
    }, 201)
  } catch (error) {
    console.error('create-ride failed:', error)
    const detail = error instanceof Error
      ? error.message
      : JSON.stringify(error) || 'Unknown server error'
    console.error('CREATE_RIDE_FAILURE:', detail)
    return respond({ error: detail }, 500)
  }
})
