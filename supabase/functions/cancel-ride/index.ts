import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// cancel-ride — student cancels their own booking.
//
// Spec (PROJECT_SPEC.md function table):
//   cancel-ride (student, ride_id): `searching`/`accepted` -> `cancelled`,
//   free the keke; `paid` (not arrived) -> calls refund-ride.
//   Returns { status }.
//
// Rules:
//   - Caller must be the ride's own student, or a signed-in admin (admins can
//     clear stuck searching/accepted bookings; paid rides are refunded via
//     admin-refund instead).
//   - searching / accepted  -> cancelled. If a keke was assigned (accepted),
//     it is released back to 'online' — guarded on kekes.status='on_trip' so
//     a concurrent trip state is never clobbered.
//   - paid -> server-to-server call to the existing refund-ride function,
//     which refunds through Paystack, marks payment + ride refunded and frees
//     the keke. This function never talks to Paystack itself.
//   - arrived / on_trip / completed / cancelled / refunded -> 409, except
//     that an already-cancelled or already-refunded ride reports success so
//     retries after a dropped response are safe.
//
// Auth: caller must be a signed-in student. Only service-role writes.

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

    const isAdmin = profile?.role === 'admin'

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
      .select('id, student_id, keke_id, status')
      .eq('id', rideId)
      .maybeSingle()

    if (rideError) throw rideError
    // The ride's own student, or an admin, may cancel.
    if (!ride || (ride.student_id !== user.id && !isAdmin)) {
      return respond({ error: 'Ride not found for this student.' }, 404)
    }

    // Retry-safe: a finished cancellation reports success.
    if (ride.status === 'cancelled') {
      return respond({ status: 'cancelled', ride_id: rideId, already_cancelled: true })
    }
    if (ride.status === 'refunded') {
      return respond({ status: 'refunded', ride_id: rideId, already_refunded: true })
    }

    if (ride.status === 'paid') {
      // Server-to-server call to the existing refund-ride function. It holds
      // the Paystack logic and frees the keke itself.
      let refundResponse: Response

      try {
        refundResponse = await fetch(
          `${supabaseUrl}/functions/v1/refund-ride`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${serviceRoleKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ ride_id: rideId }),
            signal: AbortSignal.timeout(25000),
          },
        )
      } catch {
        console.error('cancel-ride: refund-ride could not be reached.')
        return respond({
          error:
            'We could not confirm the refund request. Please try again shortly or contact support.',
        }, 502)
      }

      const refundData = await refundResponse.json().catch(() => null)

      if (!refundResponse.ok || refundData?.error) {
        return respond({
          error: refundData?.error || 'The refund could not be completed.',
        }, refundResponse.status >= 400 && refundResponse.status < 600 ? refundResponse.status : 502)
      }

      return respond({
        status: 'refunded',
        ride_id: rideId,
        message: refundData?.message,
      })
    }

    if (ride.status !== 'searching' && ride.status !== 'accepted') {
      return respond({
        error:
          `This booking can no longer be cancelled from the app because its ` +
          `status is "${ride.status}". Contact support if you need help.`,
        status: ride.status,
      }, 409)
    }

    const { data: updated, error: updateError } = await adminClient
      .from('rides')
      .update({ status: 'cancelled' })
      .eq('id', rideId)
      .in('status', ['searching', 'accepted'])
      .select('id, status, keke_id')
      .maybeSingle()

    if (updateError) throw updateError

    if (!updated) {
      // Concurrent change — report the current state rather than guessing.
      const { data: latest } = await adminClient
        .from('rides')
        .select('status')
        .eq('id', rideId)
        .maybeSingle()

      return respond({
        error: 'The ride status changed. Please refresh and try again.',
        status: latest?.status,
      }, 409)
    }

    // Free the assigned keke (guarded: only if it is still on_trip).
    if (updated.keke_id) {
      const { error: releaseError } = await adminClient
        .from('kekes')
        .update({
          status: 'online',
          last_seen: new Date().toISOString(),
        })
        .eq('id', updated.keke_id)
        .eq('status', 'on_trip')

      if (releaseError) {
        console.error('cancel-ride: could not release rider:', releaseError)
        return respond({
          status: 'cancelled',
          ride_id: rideId,
          warning: 'The ride is cancelled, but the rider status needs admin review.',
        })
      }
    }

    return respond({ status: 'cancelled', ride_id: rideId })
  } catch (error) {
    console.error('cancel-ride failed:', error)
    return respond({ error: 'Could not cancel the ride. Please try again.' }, 500)
  }
})
