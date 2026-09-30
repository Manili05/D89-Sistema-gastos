begin;

-- Cambio 9 (puente financiero): pagar una estimación de subcontrato genera un gasto
-- validado vinculado. Ese gasto es la única fuente del gasto validado del pago.
alter table public.gasto
  add column if not exists estimacion_subcontrato_id uuid
    references public.estimacion_subcontrato(id);
create unique index if not exists gasto_estimacion_subcontrato_uq
  on public.gasto(estimacion_subcontrato_id) where estimacion_subcontrato_id is not null;

-- Backfill: estimaciones pagadas antes de esta migración reciben su gasto (fecha = día del
-- pago en México), para no perder su salida de dinero del gasto validado.
do $$
declare
  pago record;
  nuevo uuid;
begin
  for pago in
    select e.id, e.folio, e.importe_neto, e.pagado_por, e.pagado_en, s.folio as sc_folio,
           s.obra_id, s.proveedor_id, s.partida_gasto_id, s.subpartida_gasto_id,
           s.categoria_gasto_id
    from public.estimacion_subcontrato e
    join public.subcontrato s on s.id = e.subcontrato_id
    where e.estado = 'pagado' and e.importe_neto > 0
      and not exists (select 1 from public.gasto g where g.estimacion_subcontrato_id = e.id)
    order by e.pagado_en, e.id
  loop
    insert into public.gasto (
      obra_id, partida_gasto_id, subpartida_gasto_id, categoria_gasto_id, proveedor_id,
      fecha, concepto, importe, subtotal, iva, iva_desglosado, estado, origen,
      creado_por, validado_por, validado_en, estimacion_subcontrato_id
    ) values (
      pago.obra_id, pago.partida_gasto_id, pago.subpartida_gasto_id, pago.categoria_gasto_id,
      pago.proveedor_id, (pago.pagado_en at time zone 'America/Mexico_City')::date,
      'Pago de Estimación ' || pago.folio || ' - Subcontrato ' || pago.sc_folio,
      pago.importe_neto, pago.importe_neto, 0, true, 'validado', 'web',
      pago.pagado_por, pago.pagado_por, pago.pagado_en, pago.id
    ) returning id into nuevo;
    insert into public.gasto_concepto
      (gasto_id, posicion, cantidad, unidad, descripcion, precio_unitario, descuento,
       importe_concepto)
    values (nuevo, 1, 1, 'servicio',
            'Pago de Estimación ' || pago.folio || ' - Subcontrato ' || pago.sc_folio,
            pago.importe_neto, 0, pago.importe_neto);
  end loop;
end
$$;

commit;
