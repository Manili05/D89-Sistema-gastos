begin;

-- Cambio 9: subcontratos a destajo (mano de obra / servicios; el material lo pone la
-- constructora) con estimaciones de pago. Evoluciona la tabla existente sin perder datos.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'estado_subcontrato') then
    create type public.estado_subcontrato as enum ('activo', 'finiquitado', 'cancelado');
  end if;
  if not exists (select 1 from pg_type where typname = 'tipo_estimacion') then
    create type public.tipo_estimacion as enum ('anticipo', 'avance', 'finiquito');
  end if;
  if not exists (select 1 from pg_type where typname = 'estado_estimacion') then
    create type public.estado_estimacion as enum ('borrador', 'pagado');
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'subcontrato' and column_name = 'monto_contratado') then
    alter table public.subcontrato rename column monto_contratado to importe_contratado;
  end if;
end
$$;

-- Los campos libres del esquema inicial quedan opcionales (históricos); los nuevos
-- registros usan proveedor y clasificación del catálogo.
alter table public.subcontrato
  alter column subcontratista drop not null,
  alter column concepto drop not null,
  add column if not exists folio text,
  add column if not exists proveedor_id uuid references public.catalogo_proveedor(id),
  add column if not exists partida_gasto_id uuid references public.catalogo_partida_gasto(id),
  add column if not exists subpartida_gasto_id uuid,
  add column if not exists categoria_gasto_id uuid references public.catalogo_categoria_gasto(id),
  add column if not exists descripcion text,
  add column if not exists fondo_garantia_pct numeric(5, 2) not null default 0,
  add column if not exists estado public.estado_subcontrato not null default 'activo',
  add column if not exists creado_por uuid references public.perfil_usuario(id),
  add column if not exists actualizado_en timestamptz not null default now(),
  -- Monotonic counter: an estimation folio (EST-NN) is never reused, even after
  -- deleting a draft.
  add column if not exists estimaciones_emitidas integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'subcontrato_subpartida_partida_fk') then
    alter table public.subcontrato add constraint subcontrato_subpartida_partida_fk
      foreign key (subpartida_gasto_id, partida_gasto_id)
      references public.catalogo_subpartida_gasto(id, partida_gasto_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'subcontrato_garantia_chk') then
    alter table public.subcontrato add constraint subcontrato_garantia_chk
      check (fondo_garantia_pct >= 0 and fondo_garantia_pct <= 100);
  end if;
end
$$;

-- Un subcontrato es completo (proveedor, partida, subpartida, categoría y alcance) o es
-- un registro del esquema inicial (subcontratista en texto libre, sin proveedor).
alter table public.subcontrato drop constraint if exists subcontrato_datos_chk;
alter table public.subcontrato add constraint subcontrato_datos_chk check (
  (proveedor_id is not null and partida_gasto_id is not null
   and subpartida_gasto_id is not null and categoria_gasto_id is not null
   and char_length(coalesce(descripcion, '')) >= 3)
  or (proveedor_id is null and subcontratista is not null)
);

create sequence if not exists public.subcontrato_folio_seq;
alter sequence public.subcontrato_folio_seq owned by public.subcontrato.folio;
create or replace function public.formatear_folio_subcontrato(numero bigint)
returns text language sql immutable
return 'SC-' || case when numero < 10000 then lpad(numero::text, 4, '0') else numero::text end;

-- No retrocede la secuencia al reaplicar la migración.
select setval('public.subcontrato_folio_seq',
  greatest((select last_value from public.subcontrato_folio_seq),
           coalesce((select max(substring(folio from 4)::bigint)
                     from public.subcontrato where folio ~ '^SC-[0-9]+$'), 0), 1),
  (select is_called from public.subcontrato_folio_seq)
    or exists (select 1 from public.subcontrato where folio ~ '^SC-[0-9]+$')
);
do $$
declare target record;
begin
  for target in select id from public.subcontrato where folio is null order by creado_en, id loop
    update public.subcontrato
      set folio = public.formatear_folio_subcontrato(nextval('public.subcontrato_folio_seq'))
      where id = target.id;
  end loop;
end
$$;
alter table public.subcontrato
  alter column folio set default
    public.formatear_folio_subcontrato(nextval('public.subcontrato_folio_seq')),
  alter column folio set not null;
create unique index if not exists subcontrato_folio_uq on public.subcontrato(folio);
create index if not exists subcontrato_obra_idx on public.subcontrato(obra_id, estado, creado_en);

create table if not exists public.estimacion_subcontrato (
  id uuid primary key default gen_random_uuid(),
  subcontrato_id uuid not null references public.subcontrato(id),
  numero integer not null check (numero > 0),
  folio text not null,
  fecha date not null,
  tipo public.tipo_estimacion not null,
  importe_bruto numeric(18, 4) not null check (importe_bruto > 0),
  amortizacion_anticipo numeric(18, 4) not null default 0 check (amortizacion_anticipo >= 0),
  retencion_garantia numeric(18, 4) not null default 0 check (retencion_garantia >= 0),
  aditivas numeric(18, 4) not null default 0 check (aditivas >= 0),
  deductivas numeric(18, 4) not null default 0 check (deductivas >= 0),
  importe_neto numeric(18, 4) not null check (importe_neto >= 0),
  notas_ajustes text,
  estado public.estado_estimacion not null default 'borrador',
  pagado_por uuid references public.perfil_usuario(id),
  pagado_en timestamptz,
  creado_por uuid not null references public.perfil_usuario(id),
  creado_en timestamptz not null default now(),
  actualizado_en timestamptz not null default now(),
  unique (subcontrato_id, numero),
  -- Regla estricta: neto = bruto + aditivas - deductivas - retención - amortización.
  constraint estimacion_neto_chk check (
    importe_neto = importe_bruto + aditivas - deductivas - retencion_garantia - amortizacion_anticipo
  ),
  -- Un anticipo se paga íntegro: sin retención, amortización ni ajustes.
  constraint estimacion_anticipo_chk check (
    tipo <> 'anticipo' or (retencion_garantia = 0 and amortizacion_anticipo = 0
                           and aditivas = 0 and deductivas = 0)
  ),
  constraint estimacion_ajustes_nota_chk check (
    (aditivas = 0 and deductivas = 0) or char_length(coalesce(notas_ajustes, '')) >= 5
  ),
  constraint estimacion_pago_chk check (
    estado <> 'pagado' or (pagado_por is not null and pagado_en is not null)
  )
);
update public.subcontrato s set estimaciones_emitidas = greatest(s.estimaciones_emitidas,
  coalesce((select max(e.numero) from public.estimacion_subcontrato e
            where e.subcontrato_id = s.id), 0));

create unique index if not exists estimacion_un_finiquito_uq
  on public.estimacion_subcontrato(subcontrato_id) where tipo = 'finiquito';
create index if not exists estimacion_subcontrato_idx
  on public.estimacion_subcontrato(subcontrato_id, estado, fecha);

-- Sólo lectura por PostgREST; toda mutación pasa por FastAPI.
alter table public.subcontrato enable row level security;
alter table public.estimacion_subcontrato enable row level security;
alter table public.subcontrato_pago enable row level security;
grant select on public.subcontrato, public.estimacion_subcontrato to authenticated;
grant all on public.subcontrato, public.estimacion_subcontrato, public.subcontrato_pago to service_role;
grant all on sequence public.subcontrato_folio_seq to service_role;
revoke insert, update, delete on public.subcontrato, public.estimacion_subcontrato,
  public.subcontrato_pago from PUBLIC, anon, authenticated;
revoke all on sequence public.subcontrato_folio_seq from PUBLIC, anon, authenticated;

drop policy if exists estimacion_subcontrato_asignado_select on public.estimacion_subcontrato;
create policy estimacion_subcontrato_asignado_select on public.estimacion_subcontrato
  for select to authenticated using (
    exists (select 1 from public.subcontrato s
            where s.id = subcontrato_id and public.puede_acceder_obra(s.obra_id))
  );

-- Defensa independiente de REVOKE: neutraliza subcontrato_admin_all,
-- subcontrato_pago_admin y futuros grants.
do $$
declare tabla text;
begin
  foreach tabla in array array['subcontrato', 'estimacion_subcontrato', 'subcontrato_pago'] loop
    execute format('drop policy if exists %I on public.%I', tabla || '_insert_solo_backend', tabla);
    execute format('create policy %I on public.%I as restrictive for insert
      to anon, authenticated with check (false)', tabla || '_insert_solo_backend', tabla);
    execute format('drop policy if exists %I on public.%I', tabla || '_update_solo_backend', tabla);
    execute format('create policy %I on public.%I as restrictive for update
      to anon, authenticated using (false) with check (false)', tabla || '_update_solo_backend', tabla);
    execute format('drop policy if exists %I on public.%I', tabla || '_delete_solo_backend', tabla);
    execute format('create policy %I on public.%I as restrictive for delete
      to anon, authenticated using (false)', tabla || '_delete_solo_backend', tabla);
  end loop;
end
$$;

notify pgrst, 'reload schema';
commit;
