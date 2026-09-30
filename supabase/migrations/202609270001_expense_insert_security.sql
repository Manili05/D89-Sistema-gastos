begin;

-- Business creation goes through FastAPI's private, privileged connection.
-- Do not change historical rows, SELECT policies or UPDATE permissions.
revoke insert on table public.gasto from PUBLIC, anon, authenticated;

-- Defense in depth: permissive policies (including gasto_admin_all) cannot
-- override this restriction, even if INSERT is accidentally granted again.
create policy gasto_insert_solo_backend on public.gasto
  as restrictive for insert to anon, authenticated
  with check (false);

commit;
