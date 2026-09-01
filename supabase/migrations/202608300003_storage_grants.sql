begin;

grant usage on schema storage to authenticated, service_role;
grant select on storage.buckets to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
grant usage, select on all sequences in schema storage to authenticated;

grant all privileges on all tables in schema storage to service_role;
grant all privileges on all sequences in schema storage to service_role;

drop policy if exists comprobantes_bucket_read on storage.buckets;
create policy comprobantes_bucket_read on storage.buckets for select to authenticated
using (id = 'comprobantes');

commit;
