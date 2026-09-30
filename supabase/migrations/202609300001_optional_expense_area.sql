begin;

-- Cambio 8: la captura se clasifica por Partida → Subpartida → Categoría → Proveedor
-- (catálogo de 23 partidas del formato de estimaciones). El área NEODATA pasa a ser un
-- vínculo opcional; los gastos existentes conservan su área.
alter table public.gasto alter column area_id drop not null;

-- La partida NEODATA (presupuesto_partida) pertenece a un área: no puede quedar suelta.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'gasto_partida_neodata_requiere_area') then
    alter table public.gasto add constraint gasto_partida_neodata_requiere_area
      check (partida_id is null or area_id is not null);
  end if;
end
$$;

-- Desglose del Resumen por partida y categoría del catálogo operativo.
create index if not exists gasto_obra_partida_gasto_idx
  on public.gasto(obra_id, partida_gasto_id, categoria_gasto_id, estado)
  where eliminado_en is null;

commit;
