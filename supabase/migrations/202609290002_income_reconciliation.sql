begin;

-- Conciliación de ingresos: quién y cuándo concilió, y el motivo si se revirtió.
alter table public.ingreso
  add column if not exists conciliado_por uuid references public.perfil_usuario(id),
  add column if not exists conciliado_en timestamptz,
  add column if not exists motivo_reversion text;

-- Ingresos ya conciliados antes de esta migración: se atribuyen a quien los capturó.
update public.ingreso
set conciliado_por = coalesce(conciliado_por, creado_por),
    conciliado_en = coalesce(conciliado_en, creado_en)
where estado = 'conciliado' and (conciliado_por is null or conciliado_en is null);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'ingreso_conciliacion_chk') then
    alter table public.ingreso add constraint ingreso_conciliacion_chk check (
      estado <> 'conciliado' or (conciliado_por is not null and conciliado_en is not null)
    );
  end if;
end
$$;

commit;
