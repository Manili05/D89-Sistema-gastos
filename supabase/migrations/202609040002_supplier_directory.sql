begin;

alter table public.catalogo_proveedor
  add column if not exists razon_social text,
  add column if not exists rfc text,
  add column if not exists telefono text,
  add column if not exists whatsapp text,
  add column if not exists email text,
  add column if not exists direccion text,
  add column if not exists cobertura text,
  add column if not exists notas text,
  add column if not exists actualizado_por uuid references public.perfil_usuario(id),
  add column if not exists actualizado_en timestamptz not null default now(),
  add column if not exists archivado_por uuid references public.perfil_usuario(id),
  add column if not exists archivado_en timestamptz;

create unique index if not exists catalogo_proveedor_rfc_uq
  on public.catalogo_proveedor (
    upper(regexp_replace(rfc, '[^A-Za-z0-9]', '', 'g'))
  ) where rfc is not null and btrim(rfc) <> '';

create table if not exists public.catalogo_especialidad_proveedor (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nombre_normalizado text generated always as (public.normalizar_texto(nombre)) stored,
  activo boolean not null default true,
  creado_por uuid references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  actualizado_por uuid references public.perfil_usuario(id),
  actualizado_en timestamptz not null default now(),
  unique (nombre_normalizado)
);

create table if not exists public.proveedor_especialidad (
  proveedor_id uuid not null references public.catalogo_proveedor(id),
  especialidad_id uuid not null references public.catalogo_especialidad_proveedor(id),
  creado_por uuid references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  primary key (proveedor_id, especialidad_id)
);

create table if not exists public.obra_proveedor (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obra(id) on delete cascade,
  proveedor_id uuid not null references public.catalogo_proveedor(id),
  notas text,
  activo boolean not null default true,
  asignado_por uuid references public.perfil_usuario(id),
  asignado_en timestamptz not null default now(),
  desasignado_por uuid references public.perfil_usuario(id),
  desasignado_en timestamptz,
  unique (obra_id, proveedor_id)
);

create table if not exists public.evaluacion_proveedor (
  id uuid primary key default gen_random_uuid(),
  proveedor_id uuid not null references public.catalogo_proveedor(id),
  obra_id uuid references public.obra(id) on delete set null,
  obra_nombre text not null,
  gasto_id uuid references public.gasto(id) on delete set null,
  trabajo text not null,
  fecha_servicio date not null,
  calidad smallint not null check (calidad between 1 and 5),
  cumplimiento smallint not null check (cumplimiento between 1 and 5),
  costo_valor smallint not null check (costo_valor between 1 and 5),
  comunicacion smallint not null check (comunicacion between 1 and 5),
  seguridad_orden smallint not null check (seguridad_orden between 1 and 5),
  calificacion numeric(3, 2) generated always as (
    (calidad + cumplimiento + costo_valor + comunicacion + seguridad_orden)::numeric / 5
  ) stored,
  comentario text,
  vigente boolean not null default true,
  creado_por uuid not null references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  actualizado_por uuid references public.perfil_usuario(id),
  actualizado_en timestamptz not null default now(),
  anulado_por uuid references public.perfil_usuario(id),
  anulado_en timestamptz,
  motivo_anulacion text,
  check (length(btrim(obra_nombre)) >= 2),
  check (length(btrim(trabajo)) >= 3)
);

create index if not exists proveedor_especialidad_filtro_idx
  on public.proveedor_especialidad(especialidad_id, proveedor_id);
create index if not exists obra_proveedor_activo_idx
  on public.obra_proveedor(obra_id, proveedor_id) where activo;
create index if not exists proveedor_obra_activo_idx
  on public.obra_proveedor(proveedor_id, obra_id) where activo;
create index if not exists evaluacion_proveedor_fecha_idx
  on public.evaluacion_proveedor(proveedor_id, fecha_servicio desc) where vigente;
create index if not exists evaluacion_obra_idx
  on public.evaluacion_proveedor(obra_id, fecha_servicio desc) where vigente;

insert into public.catalogo_especialidad_proveedor (nombre)
values
  ('Plomería'), ('Carpintería'), ('Electricidad'), ('Albañilería'),
  ('Herrería'), ('Pintura'), ('Impermeabilización'), ('Acabados'),
  ('Instalaciones hidráulicas'), ('Instalaciones sanitarias')
on conflict (nombre_normalizado)
do update set nombre = excluded.nombre, activo = true, actualizado_en = now();

insert into public.obra_proveedor (obra_id, proveedor_id, notas)
select distinct g.obra_id, g.proveedor_id, 'Asignación recuperada de gastos existentes'
from public.gasto g
where g.proveedor_id is not null
on conflict (obra_id, proveedor_id)
do update set activo = true, desasignado_por = null, desasignado_en = null;

alter table public.catalogo_especialidad_proveedor enable row level security;
alter table public.proveedor_especialidad enable row level security;
alter table public.obra_proveedor enable row level security;
alter table public.evaluacion_proveedor enable row level security;

create policy especialidad_proveedor_read on public.catalogo_especialidad_proveedor
  for select to authenticated using (true);
create policy especialidad_proveedor_admin on public.catalogo_especialidad_proveedor
  for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy proveedor_especialidad_read on public.proveedor_especialidad
  for select to authenticated using (true);
create policy proveedor_especialidad_admin on public.proveedor_especialidad
  for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy obra_proveedor_read on public.obra_proveedor
  for select to authenticated using (public.es_admin() or public.puede_acceder_obra(obra_id));
create policy obra_proveedor_admin on public.obra_proveedor
  for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy evaluacion_proveedor_read on public.evaluacion_proveedor
  for select to authenticated using (vigente or public.es_admin());
create policy evaluacion_proveedor_admin on public.evaluacion_proveedor
  for all to authenticated using (public.es_admin()) with check (public.es_admin());

grant select, insert, update, delete on
  public.catalogo_especialidad_proveedor,
  public.proveedor_especialidad,
  public.obra_proveedor,
  public.evaluacion_proveedor to authenticated;
grant all privileges on
  public.catalogo_especialidad_proveedor,
  public.proveedor_especialidad,
  public.obra_proveedor,
  public.evaluacion_proveedor to service_role;

comment on table public.obra_proveedor is
  'Asignación controlada de proveedores del directorio a obras D89.';
comment on table public.evaluacion_proveedor is
  'Historial auditable de desempeño por obra y trabajo; conserva el nombre de la obra.';

commit;
