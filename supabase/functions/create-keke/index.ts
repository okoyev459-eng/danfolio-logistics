import { createClient } from 'npm:@supabase/supabase-js@2'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const url = Deno.env.get('SUPABASE_URL')!

  // 1. Check the caller is a signed-in admin
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  })
  const { data: { user } } = await caller.auth.getUser()
  if (!user) return json({ error: 'Not signed in' }, 401)
  const { data: me } = await caller.from('profiles').select('role').eq('id', user.id).single()
  if (me?.role !== 'admin') return json({ error: 'Admins only' }, 403)

  // 2. Read and validate the form. The admin screen is the only caller, but
  // the function is reachable with any admin session, so it never trusts the
  // field shapes, the lengths, or a malformed JSON body.
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return json({ error: 'Invalid request body' }, 400)
  }

  const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const kekeNumber = typeof body.keke_number === 'string' ? body.keke_number.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!fullName || !kekeNumber || !password) return json({ error: 'Missing fields' }, 400)
  if (fullName.length > 80) {
    return json({ error: 'Full name is too long (80 characters max)' }, 400)
  }
  if (phone && !/^\+?[0-9][0-9 -]{6,19}$/.test(phone)) {
    return json({ error: 'Enter a valid phone number, e.g. +2348012345678' }, 400)
  }
  // 6 is this project's minimum; 72 is bcrypt's useful maximum.
  if (password.length < 6) return json({ error: 'Password too short' }, 400)
  if (password.length > 72) {
    return json({ error: 'Password is too long (72 characters max)' }, 400)
  }

  const kn = kekeNumber.toUpperCase().replace(/\s+/g, ' ')
  if (kn.length > 24 || !/^[A-Z0-9 -]+$/.test(kn)) {
    return json({ error: 'Keke number can only contain letters, numbers, spaces and dashes.' }, 400)
  }
  const loginEmail = kn.toLowerCase().replace(/[^a-z0-9]/g, '') + '@danfolio.app'

  // 3. Create the account (service role key is added by Supabase automatically)
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: created, error } = await admin.auth.admin.createUser({
    email: loginEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })
  if (error) return json({ error: error.message }, 400)

  const id = created.user.id
  await admin.from('profiles').update({ role: 'keke', phone }).eq('id', id)
  const { error: kErr } = await admin.from('kekes').insert({ id, keke_number: kn })
  if (kErr) {
    await admin.auth.admin.deleteUser(id)
    return json({ error: kErr.message }, 400)
  }

  return json({ id, keke_number: kn })
})