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

  // 2. Read the form
  const { full_name, phone, keke_number, password } = await req.json()
  if (!full_name || !keke_number || !password) return json({ error: 'Missing fields' }, 400)
  if (String(password).length < 6) return json({ error: 'Password too short' }, 400)

  const kn = String(keke_number).trim().toUpperCase().replace(/\s+/g, ' ')
  const loginEmail = kn.toLowerCase().replace(/[^a-z0-9]/g, '') + '@danfolio.app'

  // 3. Create the account (service role key is added by Supabase automatically)
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { data: created, error } = await admin.auth.admin.createUser({
    email: loginEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name },
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