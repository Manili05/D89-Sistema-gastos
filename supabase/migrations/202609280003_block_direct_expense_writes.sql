begin;

-- Toda mutación de gastos (importes, conceptos, comprobantes, cancelación) pasa por FastAPI,
-- que recalcula totales y audita. PostgREST queda de sólo lectura para estas tablas.
-- 202609270001 ya bloqueó INSERT en gasto; 202609280002 bloqueó escrituras en el detalle.
revoke update, delete on table public.gasto from PUBLIC, anon, authenticated;
revoke update, delete on table public.gasto_concepto from PUBLIC, anon, authenticated;
revoke update, delete on table public.gasto_comprobante from PUBLIC, anon, authenticated;

-- Segunda capa, independiente de los privilegios: aunque alguien vuelva a otorgar UPDATE o
-- DELETE, estas políticas restrictivas anulan las permisivas previas (gasto_propio_pendiente_update
-- y gasto_admin_all).
drop policy if exists gasto_update_solo_backend on public.gasto;
create policy gasto_update_solo_backend on public.gasto
  as restrictive for update to anon, authenticated using (false) with check (false);

drop policy if exists gasto_delete_solo_backend on public.gasto;
create policy gasto_delete_solo_backend on public.gasto
  as restrictive for delete to anon, authenticated using (false);

commit;
