-- Migration: create the 'avatars' storage bucket and its policies.
--
-- Needed by the profile photo upload (spec G5: "profile photo upload
-- (Supabase Storage, saves profiles.avatar_url)"). Without a bucket the
-- upload fails with a clear message, so this is additive and safe.
--
-- Policies follow Supabase's documented pattern for public-read buckets:
--   - anyone may READ objects in the bucket (photos are shown to riders and
--     students on the verify/ticket screens)
--   - a signed-in user may INSERT/UPDATE/DELETE only inside a folder named
--     after their own user id (profiles.id), so nobody can overwrite
--     somebody else's photo.
--
-- Safety: inserts one bucket row and three policies. No existing rows change.

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars public read"
  on storage.objects for select
  using (bucket_id = 'avatars');

create policy "avatars owner write"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars owner update"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars owner delete"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
