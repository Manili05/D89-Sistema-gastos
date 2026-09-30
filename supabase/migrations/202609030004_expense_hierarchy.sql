begin;

create table public.catalogo_partida_gasto (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nombre_normalizado text generated always as (public.normalizar_texto(nombre)) stored,
  orden integer not null default 0,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  unique (nombre_normalizado)
);

create table public.catalogo_subpartida_gasto (
  id uuid primary key default gen_random_uuid(),
  partida_gasto_id uuid not null references public.catalogo_partida_gasto(id),
  nombre text not null,
  nombre_normalizado text generated always as (public.normalizar_texto(nombre)) stored,
  orden integer not null default 0,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  unique (partida_gasto_id, nombre_normalizado),
  unique (id, partida_gasto_id)
);

create table public.catalogo_categoria_gasto (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  nombre_normalizado text generated always as (public.normalizar_texto(nombre)) stored,
  orden integer not null default 0,
  activo boolean not null default true,
  creado_en timestamptz not null default now(),
  unique (nombre_normalizado)
);

alter table public.gasto
  alter column clase_id drop not null,
  alter column partida_id drop not null,
  add column partida_gasto_id uuid,
  add column subpartida_gasto_id uuid,
  add column categoria_gasto_id uuid,
  add constraint gasto_partida_gasto_fk
    foreign key (partida_gasto_id)
    references public.catalogo_partida_gasto(id),
  add constraint gasto_subpartida_partida_fk
    foreign key (subpartida_gasto_id, partida_gasto_id)
    references public.catalogo_subpartida_gasto(id, partida_gasto_id),
  add constraint gasto_categoria_gasto_fk
    foreign key (categoria_gasto_id)
    references public.catalogo_categoria_gasto(id);

create index gasto_clasificacion_semanal_idx
  on public.gasto(obra_id, area_id, partida_gasto_id, subpartida_gasto_id, categoria_gasto_id)
  where eliminado_en is null;

insert into public.catalogo_partida_gasto (nombre, orden)
values
  ('PRELIMINARES', 1), ('TERRACERIAS', 2), ('CIMENTACION', 3),
  ('ALBANILERIA', 4), ('ESTRUCTURA', 5), ('INST ELECTRICA', 6),
  ('INST VOZ Y DATOS', 7), ('INST HIDROSANITARIA', 8), ('INST RIEGO', 9),
  ('GAS', 10), ('INST AIRES ACOND', 11), ('ACABADOS', 12), ('HERRERIA', 13),
  ('ALUMINIO', 14), ('CARPINTERIA', 15), ('EQUIPOS Y ACCESORIOS', 16),
  ('JARDINERIA', 17), ('LIMPIEZA', 18), ('GENERALES', 19), ('RENTAS EQUIPO', 20),
  ('VIATICOS', 21), ('INDIRECTOS D89', 22), ('ADITIVAS', 23)
on conflict (nombre_normalizado)
do update set nombre = excluded.nombre, orden = excluded.orden, activo = true;

with fuente(partida, subpartidas) as (
  values
    ('PRELIMINARES', array['LIMPIEZA','TRAZO Y NIVEL','DESPALME','INST PROVICIONALES','CFE','INTERNET','CERCADO Y PROTECCION','BODEGA','TAPIAL O CERCADO','DESMANTELAMIENTO','CAMARAS','BAÑO','DEMOLICION']::text[]),
    ('TERRACERIAS', array['TRAZO Y NIVEL','RETIRO DE MATERIAL','MOVIMIENTOS DE TIERRA','RELLENOS Y NIVELACION']::text[]),
    ('CIMENTACION', array['TRAZO Y NIVEL','EXCAVACION','PLANTILLAS','SUELOCEMENTO','ANCLAJES','ZAPATAS Y DADOS','CIMENTACION CORRIDA','IMPERMEABILIZACION','RELLENOS Y COMPACTADO']::text[]),
    ('ALBANILERIA', array['TRAZO Y NIVEL','DALAS Y CASTILLOS','COLUMNAS','MUROS','PRETILES','LOSAS','FIRMES Y HORMIGONES','LADRILLO DE AZOTEA','APLANADOS','TABLAROCA Y DUROC','TEXTURAS','POZOS Y REGISTROS','BANQUETAS Y RAMPAS','ESCALERAS']::text[]),
    ('ESTRUCTURA', array['TRAZO Y NIVEL','ESTRUCTURA METALICA','LAMINACION Y MOLDURAS','FONDO ANTICORROSIVO']::text[]),
    ('INST ELECTRICA', array['ACOMETIDA Y BASE','TABLEROS Y CONTROL','SALIDA ACCESORIO','INSTALACION DE EQUIPOS']::text[]),
    ('INST VOZ Y DATOS', array['CONCENTRACION','SALIDA ACCESORIO','INSTALACION DE EQUIPOS']::text[]),
    ('INST HIDROSANITARIA', array['ALBANAL PRAL SANITARIO','BAJANTE SANITARIO','INTERCONEXION CALLE','SALIDA SANITARIA','MEDICION HIDRA','SISTEMA CISTERNA','SISTEMA HIDRONEMATICO','SALIDA HIDRAULICA','INSTALACION MUEBLES','INSTALACION ACCESORIOS']::text[]),
    ('INST RIEGO', array['CONTROL','CUADROS DE VALVULAS','SALIDA RIEGO','MANGUERA O TUBERIA','ROSIADORES Y GOTEROS']::text[]),
    ('GAS', array['SALIDA MUEBLE','INSTA GENERAL','ACOMETIDA PRAL']::text[]),
    ('INST AIRES ACOND', array['DUCTERIA PRAL','DRENES','INSTA ELECTRICA','TUBERIA GAS']::text[]),
    ('ACABADOS', array['FONDO VINILICO','PINTURA VINILICA','FONDO ANTICORROSIVI','PINTURA ESMALTE','PISOS Y ZOCLOS','AZULEJO Y MUROS','IMPERMEABILIZANTES','RECUBRIMIENTOS VARIOS']::text[]),
    ('HERRERIA', array['PUERTAS Y PORTONES','MUEBLES DE BAÑO','ESCALERAS Y BARANDALES','PROTECCION','TAPAS Y REGISTROS','HERRERIA VARIOS']::text[]),
    ('ALUMINIO', array['VENTANAS','DOMOS','PUERTAS','CANCELES BAÑO','ESPEJOS','BARANDALES','FACHADAS']::text[]),
    ('CARPINTERIA', array['COCINA','PUERTAS','CLOSET','MUEBLES BAÑO','LAMBRINES Y DECKS','MUEBLES FIJOS']::text[]),
    ('EQUIPOS Y ACCESORIOS', array['ELECTRICOS','HIDRAULICOS','SANITARIOS','COCINA','GAS Y CALEFACCION','AIRES ACOND','RIEGO','VOZ Y DATOS','EQUIPOS VARIOS']::text[]),
    ('JARDINERIA', array['PLANTAS','TIERRA Y PIEDRA','ORNAMENTACION']::text[]),
    ('LIMPIEZA', array['DURANTE OBRA','FINA DE OBRA','ENTREGA DE OBRA']::text[]),
    ('GENERALES', array['VARIOS']::text[]),
    ('RENTAS EQUIPO', array['VARIOS']::text[]),
    ('VIATICOS', array['VARIOS']::text[]),
    ('INDIRECTOS D89', array['VARIOS']::text[]),
    ('ADITIVAS', array['VARIOS']::text[])
), expandida as (
  select partida, subpartida, orden::integer
  from fuente
  cross join lateral unnest(subpartidas) with ordinality as u(subpartida, orden)
)
insert into public.catalogo_subpartida_gasto (partida_gasto_id, nombre, orden)
select cp.id, e.subpartida, e.orden
from expandida e
join public.catalogo_partida_gasto cp
  on cp.nombre_normalizado = public.normalizar_texto(e.partida)
on conflict (partida_gasto_id, nombre_normalizado)
do update set nombre = excluded.nombre, orden = excluded.orden, activo = true;

insert into public.catalogo_categoria_gasto (nombre, orden)
values ('MATERIAL', 1), ('MANO DE OBRA', 2), ('EQUIPO/HERR', 3)
on conflict (nombre_normalizado)
do update set nombre = excluded.nombre, orden = excluded.orden, activo = true;

alter table public.catalogo_partida_gasto enable row level security;
alter table public.catalogo_subpartida_gasto enable row level security;
alter table public.catalogo_categoria_gasto enable row level security;

create policy catalogo_partida_gasto_read on public.catalogo_partida_gasto
  for select to authenticated using (true);
create policy catalogo_partida_gasto_admin on public.catalogo_partida_gasto
  for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy catalogo_subpartida_gasto_read on public.catalogo_subpartida_gasto
  for select to authenticated using (true);
create policy catalogo_subpartida_gasto_admin on public.catalogo_subpartida_gasto
  for all to authenticated using (public.es_admin()) with check (public.es_admin());
create policy catalogo_categoria_gasto_read on public.catalogo_categoria_gasto
  for select to authenticated using (true);
create policy catalogo_categoria_gasto_admin on public.catalogo_categoria_gasto
  for all to authenticated using (public.es_admin()) with check (public.es_admin());

grant select, insert, update, delete on public.catalogo_partida_gasto,
  public.catalogo_subpartida_gasto, public.catalogo_categoria_gasto to authenticated;
grant all privileges on public.catalogo_partida_gasto,
  public.catalogo_subpartida_gasto, public.catalogo_categoria_gasto to service_role;

comment on table public.catalogo_partida_gasto is
  'Partidas del menú semanal de gastos, separadas del presupuesto NEODATA.';
comment on table public.catalogo_subpartida_gasto is
  'Subpartidas dependientes del menú semanal de gastos D89.';
comment on column public.gasto.partida_id is
  'Referencia presupuestal NEODATA opcional para el gasto.';

commit;
