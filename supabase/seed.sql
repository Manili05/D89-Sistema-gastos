insert into public.permiso_tool (tool_name, rol, habilitado, condicion) values
  ('registrar_gasto', 'admin', true, 'ninguna'),
  ('registrar_gasto', 'operativo', true, 'ninguna'),
  ('consultar_presupuesto_restante', 'admin', true, 'ninguna'),
  ('consultar_presupuesto_restante', 'operativo', true, 'ninguna'),
  ('consultar_variacion_obra', 'admin', true, 'ninguna'),
  ('consultar_variacion_obra', 'operativo', true, 'ninguna'),
  ('editar_gasto_propio', 'admin', true, 'hasta_validado'),
  ('editar_gasto_propio', 'operativo', true, 'hasta_validado'),
  ('registrar_ingreso_cobro', 'admin', true, 'ninguna'),
  ('consultar_flujo_caja', 'admin', true, 'ninguna'),
  ('registrar_pago_subcontrato', 'admin', true, 'ninguna'),
  ('consultar_dashboard_agencia', 'admin', true, 'ninguna'),
  ('listar_mis_obras', 'admin', true, 'ninguna'),
  ('listar_mis_obras', 'operativo', true, 'ninguna'),
  ('exportar_reporte', 'admin', true, 'ninguna'),
  ('exportar_reporte', 'operativo', false, 'ninguna')
on conflict (tool_name, rol) do update set
  habilitado = excluded.habilitado,
  condicion = excluded.condicion;

insert into public.configuracion_variacion (
  obra_id, umbral_verde_pct, umbral_ambar_pct
) values (null, 10, 25)
on conflict (obra_id) do nothing;

-- El usuario admin se crea mediante Supabase Auth Admin API. Después se asigna el perfil:
-- insert into public.perfil_usuario (id, nombre, telefono_whatsapp, rol)
-- values ('UUID-DE-AUTH-USERS', 'Administrador D89', '+52...', 'admin');
