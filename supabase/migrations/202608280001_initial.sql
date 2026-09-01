begin;

create extension if not exists pgcrypto;

create type public.rol_usuario as enum ('admin', 'operativo');
create type public.estado_obra as enum ('activa', 'pausada', 'cerrada');
create type public.tipo_importacion as enum ('inicial', 'nueva_version', 'extra');
create type public.estado_importacion as enum ('preview', 'confirmado', 'descartado');
create type public.origen_presupuesto as enum ('neodata', 'manual');
create type public.estado_gasto as enum ('pendiente', 'validado');
create type public.origen_movimiento as enum ('web', 'whatsapp');
create type public.estado_ingreso as enum ('cobrado', 'por_cobrar');
create type public.estado_cierre as enum ('cerrado', 'reabierto');
create type public.resultado_tool as enum ('ejecutado', 'rechazado_permiso', 'error');

create or replace function public.normalizar_texto(valor text)
returns text
language sql
immutable
parallel safe
return upper(regexp_replace(translate(coalesce(valor, ''),
  'ÁÉÍÓÚÜÑáéíóúüñ', 'AEIOUUNaeiouun'), '\s+', ' ', 'g'));

create table public.perfil_usuario (
  id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null check (char_length(nombre) between 2 and 180),
  telefono_whatsapp text unique,
  rol public.rol_usuario not null default 'operativo',
  activo boolean not null default true,
  creado_en timestamptz not null default now()
);

create table public.obra (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  ubicacion text,
  fecha_inicio date,
  fecha_fin date,
  responsable_id uuid references public.perfil_usuario(id),
  estado public.estado_obra not null default 'activa',
  creado_en timestamptz not null default now(),
  check (fecha_fin is null or fecha_inicio is null or fecha_fin >= fecha_inicio)
);

create table public.usuario_obra (
  usuario_id uuid not null references public.perfil_usuario(id) on delete cascade,
  obra_id uuid not null references public.obra(id) on delete cascade,
  primary key (usuario_id, obra_id)
);

create table public.permiso_tool (
  id uuid primary key default gen_random_uuid(),
  tool_name text not null,
  rol public.rol_usuario not null,
  habilitado boolean not null default true,
  condicion text not null default 'ninguna'
    check (condicion in ('ninguna', 'hasta_validado', 'ventana_horas')),
  valor_condicion numeric,
  unique (tool_name, rol)
);

create table public.area (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obra(id) on delete cascade,
  nombre text not null,
  orden integer not null default 0,
  creado_en timestamptz not null default now(),
  unique (obra_id, nombre)
);

create table public.catalogo_clase (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nombre_normalizado text generated always as (public.normalizar_texto(nombre)) stored,
  activo boolean not null default true,
  creado_por uuid references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  unique (nombre_normalizado)
);

create table public.catalogo_categoria (
  id uuid primary key default gen_random_uuid(),
  clase_id uuid not null references public.catalogo_clase(id),
  nombre text not null,
  nombre_normalizado text generated always as (public.normalizar_texto(nombre)) stored,
  activo boolean not null default true,
  creado_por uuid references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  unique (clase_id, nombre_normalizado)
);

create table public.catalogo_partida (
  id uuid primary key default gen_random_uuid(),
  clase_id uuid not null references public.catalogo_clase(id),
  categoria_id uuid references public.catalogo_categoria(id),
  codigo text not null,
  descripcion text not null,
  unidad text not null,
  codigo_normalizado text generated always as (public.normalizar_texto(codigo)) stored,
  descripcion_normalizada text generated always as (public.normalizar_texto(descripcion)) stored,
  unidad_normalizada text generated always as (public.normalizar_texto(unidad)) stored,
  activo boolean not null default true,
  creado_por uuid references public.perfil_usuario(id),
  creado_en timestamptz not null default now()
);
create unique index catalogo_partida_identidad_uq on public.catalogo_partida (
  codigo_normalizado,
  descripcion_normalizada,
  unidad_normalizada,
  clase_id,
  coalesce(categoria_id, '00000000-0000-0000-0000-000000000000'::uuid)
);
create index catalogo_partida_codigo_idx on public.catalogo_partida(codigo_normalizado);

create table public.catalogo_proveedor (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nombre_normalizado text generated always as (public.normalizar_texto(nombre)) stored,
  contacto text,
  activo boolean not null default true,
  creado_por uuid references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  unique (nombre_normalizado)
);

create table public.importacion_neodata (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obra(id) on delete cascade,
  archivo_nombre text not null,
  archivo_sha256 text not null,
  hojas jsonb not null default '[]'::jsonb,
  tipo public.tipo_importacion,
  version_resultante integer,
  estado public.estado_importacion not null default 'preview',
  preview_json jsonb not null,
  catalogo_nuevo_json jsonb not null default '{}'::jsonb,
  confirmado_por uuid references public.perfil_usuario(id),
  confirmado_en timestamptz,
  creado_en timestamptz not null default now(),
  unique (obra_id, archivo_sha256, estado)
);

create table public.presupuesto_partida (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obra(id) on delete cascade,
  area_id uuid not null references public.area(id) on delete cascade,
  partida_id uuid not null references public.catalogo_partida(id),
  cantidad numeric(18, 6) not null check (cantidad >= 0),
  precio_unitario numeric(18, 6) not null check (precio_unitario >= 0),
  importe numeric(18, 4) not null check (importe >= 0),
  version integer not null check (version > 0),
  vigente boolean not null default true,
  origen public.origen_presupuesto not null,
  importacion_id uuid references public.importacion_neodata(id),
  actualizado_en timestamptz not null default now(),
  unique (obra_id, area_id, partida_id, version)
);
create index presupuesto_vigente_idx
  on public.presupuesto_partida(obra_id, area_id, partida_id) where vigente;

create table public.configuracion_variacion (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid unique references public.obra(id) on delete cascade,
  umbral_verde_pct numeric(7, 3) not null default 10,
  umbral_ambar_pct numeric(7, 3) not null default 25,
  actualizado_por uuid references public.perfil_usuario(id),
  actualizado_en timestamptz not null default now(),
  check (umbral_verde_pct >= 0 and umbral_ambar_pct >= umbral_verde_pct)
);

create table public.gasto (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obra(id),
  area_id uuid not null references public.area(id),
  clase_id uuid not null references public.catalogo_clase(id),
  categoria_id uuid references public.catalogo_categoria(id),
  partida_id uuid not null references public.catalogo_partida(id),
  proveedor_id uuid references public.catalogo_proveedor(id),
  fecha date not null,
  concepto text not null,
  folio text,
  importe numeric(18, 4) not null check (importe > 0),
  estado public.estado_gasto not null default 'pendiente',
  comprobante_path text,
  origen public.origen_movimiento not null default 'web',
  creado_por uuid not null references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  editado_por uuid references public.perfil_usuario(id),
  editado_en timestamptz,
  eliminado_por uuid references public.perfil_usuario(id),
  eliminado_en timestamptz
);
create index gasto_obra_fecha_idx on public.gasto(obra_id, fecha) where eliminado_en is null;
create index gasto_partida_idx on public.gasto(partida_id) where eliminado_en is null;

create table public.cierre_semanal (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obra(id),
  anio_iso integer not null check (anio_iso between 2000 and 2200),
  semana_iso integer not null check (semana_iso between 1 and 53),
  estado public.estado_cierre not null default 'cerrado',
  cerrado_por uuid not null references public.perfil_usuario(id),
  cerrado_en timestamptz not null default now(),
  reabierto_por uuid references public.perfil_usuario(id),
  reabierto_en timestamptz,
  motivo_reapertura text,
  unique (obra_id, anio_iso, semana_iso),
  check (
    (estado = 'cerrado' and reabierto_por is null and reabierto_en is null)
    or
    (estado = 'reabierto' and reabierto_por is not null and reabierto_en is not null
      and char_length(motivo_reapertura) >= 10)
  )
);

create table public.cierre_semanal_gasto (
  cierre_id uuid not null references public.cierre_semanal(id),
  gasto_id uuid not null references public.gasto(id),
  importe_al_cierre numeric(18, 4) not null,
  estado_al_cierre public.estado_gasto not null,
  primary key (cierre_id, gasto_id)
);

create table public.ingreso (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obra(id),
  concepto text not null,
  fecha_estimada date not null,
  fecha_real date,
  monto numeric(18, 4) not null check (monto > 0),
  estado public.estado_ingreso not null default 'por_cobrar',
  creado_por uuid not null references public.perfil_usuario(id),
  creado_en timestamptz not null default now()
);

create table public.subcontrato (
  id uuid primary key default gen_random_uuid(),
  obra_id uuid not null references public.obra(id),
  subcontratista text not null,
  concepto text not null,
  alcance text,
  monto_contratado numeric(18, 4) not null check (monto_contratado > 0),
  creado_en timestamptz not null default now()
);

create table public.subcontrato_pago (
  id uuid primary key default gen_random_uuid(),
  subcontrato_id uuid not null references public.subcontrato(id),
  fecha date not null,
  monto numeric(18, 4) not null check (monto > 0),
  gasto_id_vinculado uuid references public.gasto(id),
  creado_por uuid not null references public.perfil_usuario(id),
  creado_en timestamptz not null default now()
);

create table public.audit_log_negocio (
  id uuid primary key default gen_random_uuid(),
  entidad text not null,
  entidad_id uuid not null,
  accion text not null,
  usuario_id uuid references public.perfil_usuario(id),
  canal public.origen_movimiento not null,
  detalle_json jsonb not null default '{}'::jsonb,
  creado_en timestamptz not null default now()
);
create index audit_entidad_idx on public.audit_log_negocio(entidad, entidad_id, creado_en desc);

create table public.tool_call_log (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid references public.perfil_usuario(id),
  telefono text,
  tool_name text not null,
  parametros_json jsonb not null default '{}'::jsonb,
  resultado public.resultado_tool not null,
  modelo_usado text,
  tokens_usados integer check (tokens_usados is null or tokens_usados >= 0),
  costo_estimado numeric(18, 8),
  creado_en timestamptz not null default now()
);

create table public.whatsapp_session (
  id uuid primary key default gen_random_uuid(),
  telefono text not null unique,
  usuario_id uuid references public.perfil_usuario(id),
  estado_conversacion text not null,
  contexto_json jsonb not null default '{}'::jsonb,
  expira_en timestamptz not null,
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index whatsapp_session_expira_idx on public.whatsapp_session(expira_en);

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public
return exists (
  select 1 from public.perfil_usuario p
  where p.id = auth.uid() and p.activo and p.rol = 'admin'
);

create or replace function public.puede_acceder_obra(id_obra uuid)
returns boolean language sql stable security definer set search_path = public
return public.es_admin() or exists (
  select 1 from public.usuario_obra uo
  join public.perfil_usuario p on p.id = uo.usuario_id and p.activo
  where uo.usuario_id = auth.uid() and uo.obra_id = id_obra
);

alter table public.perfil_usuario enable row level security;
alter table public.obra enable row level security;
alter table public.usuario_obra enable row level security;
alter table public.permiso_tool enable row level security;
alter table public.area enable row level security;
alter table public.catalogo_clase enable row level security;
alter table public.catalogo_categoria enable row level security;
alter table public.catalogo_partida enable row level security;
alter table public.catalogo_proveedor enable row level security;
alter table public.importacion_neodata enable row level security;
alter table public.presupuesto_partida enable row level security;
alter table public.configuracion_variacion enable row level security;
alter table public.gasto enable row level security;
alter table public.cierre_semanal enable row level security;
alter table public.cierre_semanal_gasto enable row level security;
alter table public.ingreso enable row level security;
alter table public.subcontrato enable row level security;
alter table public.subcontrato_pago enable row level security;
alter table public.audit_log_negocio enable row level security;
alter table public.tool_call_log enable row level security;
alter table public.whatsapp_session enable row level security;

create policy perfil_propio_select on public.perfil_usuario for select to authenticated
  using (id = auth.uid() or public.es_admin());
create policy perfil_admin_all on public.perfil_usuario for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy obra_asignada_select on public.obra for select to authenticated
  using (public.puede_acceder_obra(id));
create policy obra_admin_all on public.obra for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy usuario_obra_visible on public.usuario_obra for select to authenticated
  using (usuario_id = auth.uid() or public.es_admin());
create policy usuario_obra_admin_all on public.usuario_obra for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy area_asignada_select on public.area for select to authenticated
  using (public.puede_acceder_obra(obra_id));
create policy area_admin_all on public.area for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy presupuesto_asignado_select on public.presupuesto_partida for select to authenticated
  using (public.puede_acceder_obra(obra_id));
create policy presupuesto_admin_all on public.presupuesto_partida for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy gasto_asignado_select on public.gasto for select to authenticated
  using (public.puede_acceder_obra(obra_id) and eliminado_en is null);
create policy gasto_asignado_insert on public.gasto for insert to authenticated
  with check (public.puede_acceder_obra(obra_id) and creado_por = auth.uid());
create policy gasto_propio_pendiente_update on public.gasto for update to authenticated
  using (creado_por = auth.uid() and estado = 'pendiente' and eliminado_en is null)
  with check (creado_por = auth.uid() and estado = 'pendiente' and eliminado_en is null);
create policy gasto_admin_all on public.gasto for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

create policy catalogo_read on public.catalogo_clase for select to authenticated using (true);
create policy catalogo_categoria_read on public.catalogo_categoria for select to authenticated using (true);
create policy catalogo_partida_read on public.catalogo_partida for select to authenticated using (true);
create policy catalogo_proveedor_read on public.catalogo_proveedor for select to authenticated using (true);
create policy catalogo_clase_admin on public.catalogo_clase for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy catalogo_categoria_admin on public.catalogo_categoria for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy catalogo_partida_admin on public.catalogo_partida for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy catalogo_proveedor_admin on public.catalogo_proveedor for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

create policy admin_importacion on public.importacion_neodata for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy admin_permisos on public.permiso_tool for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy admin_config_variacion on public.configuracion_variacion for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy config_variacion_select on public.configuracion_variacion for select to authenticated
  using (obra_id is null or public.puede_acceder_obra(obra_id));

create policy cierre_asignado_select on public.cierre_semanal for select to authenticated
  using (public.puede_acceder_obra(obra_id));
create policy cierre_admin_all on public.cierre_semanal for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy cierre_gasto_select on public.cierre_semanal_gasto for select to authenticated
  using (exists (select 1 from public.cierre_semanal c
    where c.id = cierre_id and public.puede_acceder_obra(c.obra_id)));
create policy cierre_gasto_admin on public.cierre_semanal_gasto for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

create policy ingreso_asignado_select on public.ingreso for select to authenticated
  using (public.puede_acceder_obra(obra_id));
create policy ingreso_admin_all on public.ingreso for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy subcontrato_asignado_select on public.subcontrato for select to authenticated
  using (public.puede_acceder_obra(obra_id));
create policy subcontrato_admin_all on public.subcontrato for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
create policy subcontrato_pago_select on public.subcontrato_pago for select to authenticated
  using (exists (select 1 from public.subcontrato s
    where s.id = subcontrato_id and public.puede_acceder_obra(s.obra_id)));
create policy subcontrato_pago_admin on public.subcontrato_pago for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

create policy audit_admin_select on public.audit_log_negocio for select to authenticated
  using (public.es_admin());
create policy tool_log_admin_select on public.tool_call_log for select to authenticated
  using (public.es_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'comprobantes', 'comprobantes', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy comprobantes_read on storage.objects for select to authenticated
using (
  bucket_id = 'comprobantes'
  and public.puede_acceder_obra(((storage.foldername(name))[1])::uuid)
);
create policy comprobantes_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'comprobantes'
  and public.puede_acceder_obra(((storage.foldername(name))[1])::uuid)
);
create policy comprobantes_admin_update on storage.objects for update to authenticated
using (bucket_id = 'comprobantes' and public.es_admin());
create policy comprobantes_admin_delete on storage.objects for delete to authenticated
using (bucket_id = 'comprobantes' and public.es_admin());

commit;
