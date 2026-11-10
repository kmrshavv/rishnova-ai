insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rishnova-private-uploads',
  'rishnova-private-uploads',
  false,
  10485760,
  array['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create policy "Users read their own private uploads"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'rishnova-private-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users upload to their own private folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'rishnova-private-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users update their own private uploads"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'rishnova-private-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'rishnova-private-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

create policy "Users delete their own private uploads"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'rishnova-private-uploads'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
