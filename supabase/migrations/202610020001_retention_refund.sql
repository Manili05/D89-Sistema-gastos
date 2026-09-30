-- Cambio 9 (cierre del ciclo): devolución del fondo de garantía retenido.
-- ADD VALUE va fuera del bloque transaccional; las restricciones comparan tipo::text para
-- no usar el valor nuevo del enum en la misma transacción que lo crea.
alter type public.tipo_estimacion add value if not exists 'devolucion_fondo';

begin;

-- Una devolución regresa dinero ya retenido: neto = bruto, sin retención, amortización ni
-- ajustes. El tope (no más de lo retenido y no devuelto) lo valida FastAPI con el
-- subcontrato bloqueado.
alter table public.estimacion_subcontrato drop constraint if exists estimacion_devolucion_chk;
alter table public.estimacion_subcontrato add constraint estimacion_devolucion_chk check (
  tipo::text <> 'devolucion_fondo'
  or (retencion_garantia = 0 and amortizacion_anticipo = 0 and aditivas = 0
      and deductivas = 0 and importe_neto = importe_bruto)
);

commit;
