begin;

-- Gasto cabecera-detalle: folio automático, subtotal/IVA, N conceptos y N comprobantes.
-- `gasto.importe` sigue siendo el total final (cierres, presupuesto y reportes no cambian).

-- 1. Folio: el folio capturado era el del proveedor; el nuevo `folio` es interno (G-00001).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gasto' and column_name = 'folio'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gasto' and column_name = 'folio_proveedor'
  ) then
    alter table public.gasto rename column folio to folio_proveedor;
  end if;
end
$$;

create sequence if not exists public.gasto_folio_seq;

-- lpad() trunca: lpad('100000', 5, '0') = '10000' duplicaría folios; sólo rellena < 5 dígitos.
create or replace function public.formatear_folio_gasto(numero bigint)
returns text language sql immutable
return 'G-' || case when numero < 100000 then lpad(numero::text, 5, '0') else numero::text end;

alter table public.gasto add column if not exists folio text;

with pendientes as (
  select id, row_number() over (order by creado_en, id)
           + coalesce((select last_value from public.gasto_folio_seq where is_called), 0)
           as numero
  from public.gasto where folio is null
)
update public.gasto g set folio = public.formatear_folio_gasto(p.numero)
from pendientes p where p.id = g.id;

select setval(
  'public.gasto_folio_seq',
  greatest(
    coalesce((select max(substring(folio from 3)::bigint) from public.gasto where folio ~ '^G-[0-9]+$'), 0),
    1
  ),
  exists (select 1 from public.gasto where folio ~ '^G-[0-9]+$')
);

alter table public.gasto
  alter column folio set default public.formatear_folio_gasto(nextval('public.gasto_folio_seq')),
  alter column folio set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gasto_folio_uq') then
    alter table public.gasto add constraint gasto_folio_uq unique (folio);
  end if;
end
$$;

-- 2. Totales de cabecera. Los gastos previos quedan con IVA no desglosado (iva = 0).
alter table public.gasto
  add column if not exists subtotal numeric(18, 4),
  add column if not exists iva numeric(18, 4),
  add column if not exists iva_desglosado boolean not null default true;

update public.gasto
set subtotal = importe, iva = 0, iva_desglosado = false
where subtotal is null or iva is null;

alter table public.gasto
  alter column subtotal set not null,
  alter column iva set not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gasto_totales_chk') then
    alter table public.gasto add constraint gasto_totales_chk
      check (subtotal >= 0 and iva >= 0 and subtotal + iva = importe);
  end if;
end
$$;

-- 3. Conceptos (detalle).
create table if not exists public.gasto_concepto (
  id uuid primary key default gen_random_uuid(),
  gasto_id uuid not null references public.gasto(id) on delete cascade,
  posicion smallint not null check (posicion > 0),
  cantidad numeric(18, 4) not null check (cantidad > 0),
  unidad text not null check (char_length(btrim(unidad)) between 1 and 40),
  descripcion text not null check (char_length(btrim(descripcion)) between 1 and 500),
  precio_unitario numeric(18, 4) not null check (precio_unitario >= 0),
  descuento numeric(18, 4) not null default 0 check (descuento >= 0),
  importe_concepto numeric(18, 4) not null check (importe_concepto >= 0),
  constraint gasto_concepto_posicion_uq unique (gasto_id, posicion),
  constraint gasto_concepto_importe_chk
    check (importe_concepto = round(cantidad * precio_unitario - descuento, 2))
);
create index if not exists gasto_concepto_gasto_idx on public.gasto_concepto(gasto_id);

insert into public.gasto_concepto
  (gasto_id, posicion, cantidad, unidad, descripcion, precio_unitario, descuento, importe_concepto)
select g.id, 1, 1, 'servicio', left(g.concepto, 500), g.importe, 0, round(g.importe, 2)
from public.gasto g
where not exists (select 1 from public.gasto_concepto c where c.gasto_id = g.id);

-- 4. Comprobantes múltiples (PDF, XML CFDI, imagen).
create table if not exists public.gasto_comprobante (
  id uuid primary key default gen_random_uuid(),
  gasto_id uuid not null references public.gasto(id) on delete cascade,
  ruta text not null,
  tipo text not null check (tipo in ('pdf', 'xml', 'imagen')),
  creado_por uuid references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  constraint gasto_comprobante_ruta_uq unique (ruta)
);
create index if not exists gasto_comprobante_gasto_idx on public.gasto_comprobante(gasto_id);

insert into public.gasto_comprobante (gasto_id, ruta, tipo, creado_por, creado_en)
select g.id, g.comprobante_path,
       case
         when lower(g.comprobante_path) like '%.pdf' then 'pdf'
         when lower(g.comprobante_path) like '%.xml' then 'xml'
         else 'imagen'
       end,
       coalesce(g.editado_por, g.creado_por), coalesce(g.editado_en, g.creado_en)
from public.gasto g
where g.comprobante_path is not null
on conflict (ruta) do nothing;

comment on column public.gasto.comprobante_path is
  'Obsoleto desde 202609280002: usar gasto_comprobante. Se conserva para reversión.';

-- 5. Seguridad: sólo la API (FastAPI) escribe. api_grants otorga por defecto escritura a
-- `authenticated` sobre tablas nuevas, así que se revoca explícitamente.
alter table public.gasto_concepto enable row level security;
alter table public.gasto_comprobante enable row level security;

revoke insert, update, delete on table public.gasto_concepto from PUBLIC, anon, authenticated;
revoke insert, update, delete on table public.gasto_comprobante from PUBLIC, anon, authenticated;

drop policy if exists gasto_concepto_select on public.gasto_concepto;
create policy gasto_concepto_select on public.gasto_concepto for select to authenticated
  using (exists (
    select 1 from public.gasto g
    where g.id = gasto_id and public.puede_acceder_obra(g.obra_id) and g.eliminado_en is null
  ));

drop policy if exists gasto_comprobante_select on public.gasto_comprobante;
create policy gasto_comprobante_select on public.gasto_comprobante for select to authenticated
  using (exists (
    select 1 from public.gasto g
    where g.id = gasto_id and public.puede_acceder_obra(g.obra_id) and g.eliminado_en is null
  ));

-- Restrictivas por comando: una `for all` también anularía el SELECT permitido arriba.
drop policy if exists gasto_concepto_insert_solo_backend on public.gasto_concepto;
create policy gasto_concepto_insert_solo_backend on public.gasto_concepto
  as restrictive for insert to anon, authenticated with check (false);
drop policy if exists gasto_concepto_update_solo_backend on public.gasto_concepto;
create policy gasto_concepto_update_solo_backend on public.gasto_concepto
  as restrictive for update to anon, authenticated using (false) with check (false);
drop policy if exists gasto_concepto_delete_solo_backend on public.gasto_concepto;
create policy gasto_concepto_delete_solo_backend on public.gasto_concepto
  as restrictive for delete to anon, authenticated using (false);

drop policy if exists gasto_comprobante_insert_solo_backend on public.gasto_comprobante;
create policy gasto_comprobante_insert_solo_backend on public.gasto_comprobante
  as restrictive for insert to anon, authenticated with check (false);
drop policy if exists gasto_comprobante_update_solo_backend on public.gasto_comprobante;
create policy gasto_comprobante_update_solo_backend on public.gasto_comprobante
  as restrictive for update to anon, authenticated using (false) with check (false);
drop policy if exists gasto_comprobante_delete_solo_backend on public.gasto_comprobante;
create policy gasto_comprobante_delete_solo_backend on public.gasto_comprobante
  as restrictive for delete to anon, authenticated using (false);

-- 6. Storage: aceptar el XML del CFDI además de PDF e imágenes.
update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/xml', 'text/xml'
]
where id = 'comprobantes';

commit;
