import { createClient } from 'npm:@supabase/supabase-js@2'

// admin-delete-user — remove a student or rider account COMPLETELY.
//
// Why a function: the admin interface could not delete accounts before.
//   * kekes / rides have no DELETE policy (RLS would deny the client),
//   * payments / tickets / reviews / reports reference rides with
//     ON DELETE NO ACTION — any naive ride delete fails on the FK,
//   * auth.users can only be removed with the service-role admin API.
// This function does the whole job server-side, ADMINS ONLY, in a
// retry-safe order.
//
// Order (safe to re-run after any partial failure):
//   1. verify the caller is an admin (profiles.role = 'admin'),
//   2. refuse while the target rider is physically on a trip (on_trip),
//   3. delete the auth login FIRST — if a later step fails, a retry
//      skips this step (profile still exists) and finishes the cleanup;
//      the reverse order could leave a half-deleted person still able
//      to sign in,
//   4. delete ride children (tickets, payments, reports, reviews,
//      ride_requests, ride_locations), then the rides, then any
//      person-attached reports/reviews, then the profile row
//      (deleting it cascades the keke row).

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return json({ error: 'Sign in is required.' }, 401)
    }

    const url = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !anonKey || !serviceKey) {
      console.error('Missing Supabase function environment configuration.')
      return json({ error: 'Server configuration is incomplete.' }, 500)
    }

    // 1. Signed-in caller — re-validated against auth, then must be admin.
    const caller = createClient(url, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: { user }, error: authError } = await caller.auth.getUser()
    if (authError || !user) {
      return json({ error: 'Your session is invalid. Please sign in again.' }, 401)
    }

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: me, error: meError } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()
    if (meError) throw meError
    if (me?.role !== 'admin') return json({ error: 'Admins only.' }, 403)

    const body = await req.json().catch(() => null)
    const target = body?.user_id
    if (typeof target !== 'string' || !UUID.test(target)) {
      return json({ error: 'A valid user ID is required.' }, 400)
    }
    if (target === user.id) {
      return json({ error: 'You cannot delete your own account from this screen.' }, 400)
    }

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('id, role')
      .eq('id', target)
      .maybeSingle()
    if (profileError) throw profileError
    if (!profile) return json({ error: 'That account no longer exists.' }, 404)

    // 2. Never rip an account out from under a ride in progress.
    const { data: onTrip, error: tripError } = await admin
      .from('rides')
      .select('id')
      .eq('keke_id', target)
      .eq('status', 'on_trip')
      .limit(1)
    if (tripError) throw tripError
    if ((onTrip ?? []).length > 0) {
      return json({
        error: 'This rider is on a trip right now — finish or cancel the trip first.',
      }, 409)
    }

    // Every ride this person touches (as student or as rider).
    const { data: rides, error: ridesError } = await admin
      .from('rides')
      .select('id')
      .or(`student_id.eq.${target},keke_id.eq.${target}`)
    if (ridesError) throw ridesError
    const rideIds = (rides ?? []).map((r) => r.id)
    const rideIn = rideIds.length > 0 ? `ride_id.in.(${rideIds.join(',')})` : null

    // 3. Login first (see order note in the header comment).
    const { error: delUserError } = await admin.auth.admin.deleteUser(target)
    if (delUserError && !/not found/i.test(delUserError.message)) {
      return json({ error: `Could not remove the login: ${delUserError.message}` }, 400)
    }

    // 4. Children before parents — every FK below is ON DELETE NO ACTION.
    const deleted: Record<string, number> = {}
    const delRows = async (
      table: string,
      apply: (q: ReturnType<typeof admin.from>) => ReturnType<typeof admin.from>,
      cols: string,
    ) => {
      const { data, error } = await apply(admin.from(table).delete()).select(cols)
      if (error) throw new Error(`clearing ${table}: ${error.message}`)
      deleted[table] = data?.length ?? 0
    }

    if (rideIn) {
      await delRows('tickets', (q) => q.in('ride_id', rideIds), 'id')
      await delRows('payments', (q) => q.in('ride_id', rideIds), 'id')
    }
    await delRows(
      'reports',
      (q) => q.or([rideIn, `student_id.eq.${target}`, `keke_id.eq.${target}`].filter(Boolean).join(',')),
      'id',
    )
    await delRows(
      'reviews',
      (q) => q.or([rideIn, `student_id.eq.${target}`].filter(Boolean).join(',')),
      'id',
    )
    await delRows(
      'ride_requests',
      (q) => q.or([rideIn, `keke_id.eq.${target}`].filter(Boolean).join(',')),
      'id',
    )
    if (rideIn) {
      await delRows('ride_locations', (q) => q.in('ride_id', rideIds), 'ride_id')
      await delRows('rides', (q) => q.in('id', rideIds), 'id')
    }
    // The profile row: cascades the paired keke row (kekes.id → profiles.id).
    await delRows('profiles', (q) => q.eq('id', target), 'id')

    return json({ ok: true, deleted })
  } catch (error) {
    console.error('admin-delete-user failed:', error)
    return json({ error: 'Could not delete this account. Please try again.' }, 500)
  }
})
