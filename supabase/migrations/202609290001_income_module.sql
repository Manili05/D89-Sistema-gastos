begin;

-- Evoluciona la tabla existente sin perder importes ni fechas históricas.
do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'ingreso' and column_name = 'monto') then
    alter table public.ingreso rename column monto to importe;
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public'
             and table_name = 'ingreso' and column_name = 'fecha_estimada') then
    alter table public.ingreso rename column fecha_estimada to fecha;
  end if;
  if exists (select 1 from pg_enum where enumtypid = 'public.estado_ingreso'::regtype
             and enumlabel = 'por_cobrar') then
    alter type public.estado_ingreso rename value 'por_cobrar' to 'pendiente';
  end if;
  if exists (select 1 from pg_enum where enumtypid = 'public.estado_ingreso'::regtype
             and enumlabel = 'cobrado') then
    alter type public.estado_ingreso rename value 'cobrado' to 'conciliado';
  end if;
end
$$;

-- fecha_real se conserva para la compatibilidad del contrato /incomes anterior.
alter table public.ingreso alter column estado set default 'pendiente';
alter table public.ingreso add column if not exists folio text;
create sequence if not exists public.ingreso_folio_seq;
alter sequence public.ingreso_folio_seq owned by public.ingreso.folio;
create or replace function public.formatear_folio_ingreso(numero bigint)
returns text language sql immutable
return 'I-' || case when numero < 100000 then lpad(numero::text, 5, '0') else numero::text end;

-- No retrocede la secuencia al reaplicar la migración, incluso con huecos por rollback.
select setval('public.ingreso_folio_seq',
  greatest((select last_value from public.ingreso_folio_seq),
           coalesce((select max(substring(folio from 3)::bigint)
                     from public.ingreso where folio ~ '^I-[0-9]+$'), 0), 1),
  (select is_called from public.ingreso_folio_seq)
    or exists (select 1 from public.ingreso where folio ~ '^I-[0-9]+$')
);
do $$
declare target record;
begin
  for target in select id from public.ingreso where folio is null order by creado_en, id loop
    update public.ingreso
      set folio = public.formatear_folio_ingreso(nextval('public.ingreso_folio_seq'))
      where id = target.id;
  end loop;
end
$$;
alter table public.ingreso
  alter column folio set default public.formatear_folio_ingreso(nextval('public.ingreso_folio_seq')),
  alter column folio set not null;
create unique index if not exists ingreso_folio_uq on public.ingreso(folio);
create index if not exists ingreso_obra_fecha_idx on public.ingreso(obra_id, fecha desc, id);

create table if not exists public.ingreso_comprobante (
  id uuid primary key default gen_random_uuid(),
  ingreso_id uuid not null references public.ingreso(id) on delete cascade,
  ruta text not null unique,
  tipo text not null check (tipo in ('pdf', 'xml', 'imagen')),
  creado_por uuid not null references public.perfil_usuario(id),
  creado_en timestamptz not null default now()
);
create index if not exists ingreso_comprobante_ingreso_idx
  on public.ingreso_comprobante(ingreso_id);

alter table public.ingreso enable row level security;
alter table public.ingreso_comprobante enable row level security;
grant select on public.ingreso, public.ingreso_comprobante to authenticated;
grant all on public.ingreso, public.ingreso_comprobante to service_role;
grant all on sequence public.ingreso_folio_seq to service_role;
revoke insert, update, delete on public.ingreso from PUBLIC, anon, authenticated;
revoke insert, update, delete on public.ingreso_comprobante from PUBLIC, anon, authenticated;
revoke all on sequence public.ingreso_folio_seq from PUBLIC, anon, authenticated;

drop policy if exists ingreso_comprobante_asignado_select on public.ingreso_comprobante;
create policy ingreso_comprobante_asignado_select on public.ingreso_comprobante
  for select to authenticated using (
    exists (select 1 from public.ingreso i
            where i.id = ingreso_id and public.puede_acceder_obra(i.obra_id))
  );

-- Defensa independiente de REVOKE: neutraliza ingreso_admin_all y futuros grants.
do $$
declare tabla text;
begin
  foreach tabla in array array['ingreso', 'ingreso_comprobante'] loop
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
