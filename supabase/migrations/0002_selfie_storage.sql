-- Private bucket for check-in selfies. Files are stored as <company_id>/<user_id>/<file>.jpg

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('selfies', 'selfies', false, 1048576, array['image/jpeg','image/webp','image/png'])
on conflict (id) do nothing;

create policy "employees upload own selfies" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'selfies'
    and (storage.foldername(name))[1] = public.my_company_id()::text
    and (storage.foldername(name))[2] = auth.uid()::text
  );

create policy "employees see own selfies, admins see team selfies" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'selfies'
    and (storage.foldername(name))[1] = public.my_company_id()::text
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_admin())
  );
