import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// admin-refund — administrator manually refunds a paid ride.
//
// Refund-ride itself is server-to-server only (service key). This wrapper
// lets a signed-in ADMIN request the same refund safely: the caller's JWT is
// re-validated, the profiles.role must be 'admin', and only then is the
// service-to-service call made. The Paystack logic lives only in refund-ride.
//
// Body: { ride_id }. Returns refund-ride's response passthrough.

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
    if (profile?.role !== 'admin') {
      return respond({ error: 'Admins only.' }, 403)
    }

    const body = await req.json().catch(() => null)
    const rideId = body?.ride_id

    if (typeof rideId !== 'string' || !UUID_RE.test(rideId)) {
      return respond({ error: 'A valid ride ID is required.' }, 400)
    }

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
      console.error('admin-refund: refund-ride could not be reached.')
      return respond({
        error: 'The refund service could not be reached. Please try again.',
      }, 502)
    }

    const data = await refundResponse.json().catch(() => null)

    return respond(data ?? { error: 'Refund returned no result.' }, refundResponse.status)
  } catch (error) {
    console.error('admin-refund failed:', error)
    return respond({ error: 'Could not complete the refund. Please try again.' }, 500)
  }
})
