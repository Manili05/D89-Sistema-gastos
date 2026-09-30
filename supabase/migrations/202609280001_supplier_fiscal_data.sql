begin;

-- Fiscal data from the SAT Constancia de Situación Fiscal (optional, admin-captured).
alter table public.catalogo_proveedor
  add column if not exists regimen_fiscal text,
  add column if not exists codigo_postal text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.catalogo_proveedor'::regclass
      and conname = 'catalogo_proveedor_codigo_postal_chk'
  ) then
    alter table public.catalogo_proveedor
      add constraint catalogo_proveedor_codigo_postal_chk
      check (codigo_postal is null or codigo_postal ~ '^[0-9]{5}$');
  end if;
end
$$;

commit;
