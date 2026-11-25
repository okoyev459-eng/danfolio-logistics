-- Terms acceptance: keep a durable, per-account record of which Terms of
-- Service / Privacy Policy version a student accepted, instead of only the
-- browser's localStorage entry.
--
--   * profiles.terms_version / terms_accepted_at hold the latest acceptance.
--     Both are nullable: existing accounts have accepted nothing under this
--     definition and are asked once by the consent gate (TermsGate.jsx).
--   * Acceptance is written only through accept_terms(text), which stamps
--     auth.uid() and now() server-side. The API UPDATE grant on profiles stays
--     limited to avatar_url (20261029140000), so a client cannot forge a
--     version or backdate an acceptance with a plain table update.
--   * EXECUTE is revoked from PUBLIC/anon; `authenticated` is the only API role
--     that may call it, and it only ever touches the caller's own row.
--
-- Safety: adds two nullable columns and one new function. No existing column,
-- row, policy or grant is modified.

alter table public.profiles
  add column if not exists terms_version text,
  add column if not exists terms_accepted_at timestamptz;

comment on column public.profiles.terms_version is
  'Terms of Service / Privacy Policy version the account last accepted (TERMS_VERSION in src/components/TermsGate.jsx).';
comment on column public.profiles.terms_accepted_at is
  'Server timestamp of the acceptance recorded in terms_version.';

create or replace function public.accept_terms(p_version text)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  uid uuid := (select auth.uid());
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;

  if p_version is null or btrim(p_version) = '' or length(p_version) > 32 then
    raise exception 'invalid terms version' using errcode = '22023';
  end if;

  update public.profiles
     set terms_version = btrim(p_version),
         terms_accepted_at = pg_catalog.now()
   where id = uid;

  if not found then
    raise exception 'profile not found' using errcode = 'P0002';
  end if;
end
$function$;

revoke all on function public.accept_terms(text) from public;
revoke all on function public.accept_terms(text) from anon;
grant execute on function public.accept_terms(text) to authenticated, service_role;
