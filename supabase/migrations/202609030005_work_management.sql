alter type public.estado_gasto add value if not exists 'rechazado';

alter table public.area
  add column if not exists parent_id uuid references public.area(id),
  add column if not exists ruta_normalizada text[],
  add column if not exists nivel integer not null default 0,
  add column if not exists seleccionable boolean not null default true,
  add column if not exists vigente boolean not null default true;

update public.area
set ruta_normalizada = array[public.normalizar_texto(nombre)]
where ruta_normalizada is null;

alter table public.area alter column ruta_normalizada set not null;
alter table public.area drop constraint if exists area_obra_id_nombre_key;
alter table public.area
  add constraint area_obra_ruta_uq unique (obra_id, ruta_normalizada);
create index if not exists area_parent_idx on public.area(obra_id, parent_id, orden);

alter table public.gasto
  add column if not exists validado_por uuid references public.perfil_usuario(id),
  add column if not exists validado_en timestamptz,
  add column if not exists motivo_revision text;

create index if not exists gasto_revision_idx
  on public.gasto(obra_id, estado, fecha desc) where eliminado_en is null;
create index if not exists gasto_area_revision_idx
  on public.gasto(obra_id, area_id, estado) where eliminado_en is null;
create index if not exists gasto_proveedor_revision_idx
  on public.gasto(obra_id, proveedor_id, fecha desc) where eliminado_en is null;

comment on column public.area.ruta_normalizada is
  'Ruta jerárquica NEODATA; distingue etiquetas repetidas bajo padres diferentes.';
comment on column public.area.seleccionable is
  'Verdadero cuando el nivel contiene partidas presupuestales directamente.';
