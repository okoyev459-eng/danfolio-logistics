import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

Deno.serve(async (req) => {
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return respond({ error: 'Method not allowed.' }, 405)
  }

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return respond({ error: 'Please sign in first.' }, 401)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const paystackSecret = Deno.env.get('PAYSTACK_SECRET_KEY')

    if (!supabaseUrl || !anonKey || !serviceRoleKey || !paystackSecret) {
      return respond({ error: 'Payment service configuration is incomplete.' }, 500)
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: { user }, error: authError } =
      await userClient.auth.getUser()

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
      return respond({ error: 'Only students can pay for rides.' }, 403)
    }

    if (!user.email) {
      return respond({ error: 'Your account needs a valid email address.' }, 400)
    }

    let body: { ride_id?: string }

    try {
      body = await req.json()
    } catch {
      return respond({ error: 'Invalid request body.' }, 400)
    }

    const rideId = body?.ride_id

    if (
      typeof rideId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rideId)
    ) {
      return respond({ error: 'A valid ride ID is required.' }, 400)
    }

    const { data: ride, error: rideError } = await adminClient
      .from('rides')
      .select('id, student_id, fare, status')
      .eq('id', rideId)
      .eq('student_id', user.id)
      .maybeSingle()

    if (rideError) throw rideError

    if (!ride) {
      return respond({ error: 'Ride not found for this student.' }, 404)
    }

    if (ride.status !== 'accepted') {
      return respond({
        error: 'Payment is available only after a Keke accepts your ride.',
      }, 409)
    }

    const fareNaira = Number(ride.fare)

    if (!Number.isSafeInteger(fareNaira) || fareNaira <= 0) {
      return respond({ error: 'The ride has an invalid fare.' }, 400)
    }

    const { data: existingPayment, error: existingError } = await adminClient
      .from('payments')
      .select('id, paystack_ref, status')
      .eq('ride_id', ride.id)
      .maybeSingle()

    if (existingError) throw existingError

    if (existingPayment?.status === 'success') {
      return respond({ error: 'This ride has already been paid for.' }, 409)
    }

    if (existingPayment?.status === 'pending') {
      return respond({
        error: 'A payment is already pending for this ride. Do not start another payment attempt.',
      }, 409)
    }

    if (existingPayment?.status === 'refunded') {
      return respond({ error: 'This payment has been refunded.' }, 409)
    }

    const reference = `DF-${ride.id.slice(0, 8)}-${crypto.randomUUID()}`

    // Store the amount in naira; Paystack receives the amount in kobo.
    let paymentId: string

    if (existingPayment) {
      const { data, error } = await adminClient
        .from('payments')
        .update({
          paystack_ref: reference,
          amount: fareNaira,
          status: 'pending',
        })
        .eq('id', existingPayment.id)
        .eq('status', 'failed')
        .select('id')
        .maybeSingle()

      if (error) throw error
      if (!data) {
        return respond({
          error: 'The payment record changed. Please refresh and try again.',
        }, 409)
      }

      paymentId = data.id
    } else {
      const { data, error } = await adminClient
        .from('payments')
        .insert({
          ride_id: ride.id,
          paystack_ref: reference,
          amount: fareNaira,
          status: 'pending',
        })
        .select('id')
        .single()

      if (error) throw error
      paymentId = data.id
    }

    const transactionBody: Record<string, unknown> = {
      email: user.email,
      amount: String(fareNaira * 100),
      currency: 'NGN',
      reference,
      metadata: {
        ride_id: ride.id,
        student_id: user.id,
        payment_id: paymentId,
        app: 'Danfolio Logistics',
      },
    }

    // Use a configured app URL when available. In local development,
    // return to the student ride page on Vite's default port.
    let appBaseUrl = Deno.env.get('APP_URL')?.replace(/\/+$/, '')

    if (!appBaseUrl) {
      const origin = req.headers.get('origin')

      if (origin) {
        try {
          const parsed = new URL(origin)
          const localHost =
            parsed.protocol === 'http:' &&
            ['localhost', '127.0.0.1'].includes(parsed.hostname) &&
            parsed.port === '5173'

          if (localHost) appBaseUrl = parsed.origin
        } catch {
          // No callback URL will be added for an invalid origin.
        }
      }
    }

    if (appBaseUrl) {
      transactionBody.callback_url =
        `${appBaseUrl}/student/ride/${ride.id}`
    }

    let paystackResponse: Response
    let paystackData: {
      status?: boolean
      message?: string
      data?: {
        authorization_url?: string
        access_code?: string
        reference?: string
      }
    }

    try {
      paystackResponse = await fetch(
        'https://api.paystack.co/transaction/initialize',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${paystackSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(transactionBody),
          signal: AbortSignal.timeout(20000),
        },
      )

      paystackData = await paystackResponse.json()
    } catch (error) {
      console.error('Paystack initialization request failed:', error)

      await adminClient
        .from('payments')
        .update({ status: 'failed' })
        .eq('id', paymentId)
        .eq('status', 'pending')

      return respond({
        error: 'Paystack could not be reached. Please try again.',
      }, 502)
    }

    if (
      !paystackResponse.ok ||
      !paystackData.status ||
      !paystackData.data?.authorization_url ||
      !paystackData.data?.access_code ||
      !paystackData.data?.reference
    ) {
      await adminClient
        .from('payments')
        .update({ status: 'failed' })
        .eq('id', paymentId)
        .eq('status', 'pending')

      console.error('Paystack initialization was rejected:', paystackData.message)

      return respond({
        error: paystackData.message || 'Could not initialize the payment.',
      }, 502)
    }

    return respond({
      reference: paystackData.data.reference,
      authorization_url: paystackData.data.authorization_url,
      access_code: paystackData.data.access_code,
      amount: fareNaira,
      currency: 'NGN',
    })
  } catch (error) {
    console.error('start-payment failed:', error)

    return respond({
      error: 'Could not start the payment. Please try again.',
    }, 500)
  }
})
