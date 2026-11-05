-- The private bucket for course materials. Private means no file has a public link.
insert into storage.buckets (id, name, public, file_size_limit)
values ('materials', 'materials', false, 20971520) -- 20 MB
on conflict (id) do nothing;

-- A teacher can only touch files inside their own folder, whose name is their login id.
-- Storage checks this against the login token sent with each request, so even a bug in
-- our API couldn't hand one teacher's files to another.
create policy "Teachers use their own materials folder"
  on storage.objects
  for all
  to authenticated
  using (bucket_id = 'materials' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'materials' and (storage.foldername(name))[1] = (select auth.uid())::text);
