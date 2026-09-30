# Modelo de datos — Sistema de Control de Gastos y Presupuesto de Obra (D89)

Fuente de verdad del esquema. Cualquier migración debe reflejar exactamente esto; cualquier
cambio a este documento debe justificarse y reflejarse en la migración correspondiente.

## 1. Identidad y permisos

**`auth.users` (Supabase Auth)** es la única fuente de identidad y contraseñas.

**`PerfilUsuario`**
`id (FK auth.users.id), nombre, telefono_whatsapp (único), rol [admin|operativo], activo, creado_en`
- No existe `password_hash` en el esquema público.

**`UserObra`** (solo restringe operativos; el admin ve todo implícitamente)
`user_id, obra_id`

**`PermisoTool`** (editable solo desde el Portal Admin web)
`id, tool_name, rol [admin|operativo], habilitado (bool), condicion [ninguna|hasta_validado|ventana_horas], valor_condicion (nullable)`

## 2. Estructura de obra

**`Obra`**
`id, nombre, ubicacion, fecha_inicio, fecha_fin, responsable_id, estado [activa|pausada|cerrada], creado_en`

**`Area`** (entidad real navegable)
`id, obra_id, nombre, orden, creado_en`

**`CatalogoClase`** — `id, nombre, activo, creado_por, creado_en`
**`CatalogoCategoria`** — `id, clase_id, nombre, activo, creado_por, creado_en` (solo bajo la Clase "Instalaciones" en la práctica)
**`CatalogoPartida`** — `id, clase_id, categoria_id (nullable), codigo, descripcion, unidad, activo, creado_por, creado_en`
- Identidad canónica: `(codigo_normalizado, descripcion_normalizada, unidad_normalizada,
  clase_id, categoria_id)`. El código por sí solo no identifica una partida.
**`CatalogoProveedor`** — `id, nombre, contacto, activo, creado_por, creado_en` (único para toda la agencia)

## 3. Presupuesto (con versionado)

**`ImportacionNeodata`**
`id, obra_id, archivo_nombre, hoja_nombre, tipo [inicial|nueva_version|extra], version_resultante, estado [preview|confirmado|descartado], preview_json, catalogo_nuevo_json, confirmado_por, confirmado_en, creado_en`

**`PresupuestoPartida`**
`id, obra_id, area_id, partida_id, cantidad, precio_unitario, importe, version (int), vigente (bool), origen [neodata|manual], importacion_id (nullable), actualizado_en`
- Único: `(obra_id, area_id, partida_id, version)`
- Variación siempre calcula sobre `WHERE vigente = true`.

**`ConfiguracionVariacion`**
`id, obra_id (nullable = default global), umbral_verde_pct, umbral_ambar_pct, actualizado_por, actualizado_en`

## 4. Movimientos

**`Gasto`**
`id, obra_id, area_id (nullable desde el Cambio 8), clase_id, categoria_id (nullable), partida_id, proveedor_id, fecha, concepto, folio, importe, estado [validado|pendiente], comprobante_url, origen [web|whatsapp], creado_por, creado_en, editado_por, editado_en, eliminado_por (nullable), eliminado_en (nullable)`
- Clasificación operativa (Cambio 8): `partida_gasto_id → subpartida_gasto_id`, `categoria_gasto_id` y `proveedor_id`. El área NEODATA es un vínculo opcional; una partida NEODATA (`partida_id`) exige área.
- Borrado siempre lógico.

**`CierreSemanal`**
`id, obra_id, semana_iso, anio_iso, estado [cerrado|reabierto], cerrado_por, cerrado_en,
reabierto_por (nullable), reabierto_en (nullable), motivo_reapertura (nullable)`
- Único: `(obra_id, anio_iso, semana_iso)`.

**`CierreSemanalGasto`**
`cierre_id, gasto_id, importe_al_cierre, estado_al_cierre`
- El cierre es por lote y conserva evidencia de qué gastos incluyó. Reabrir genera
  `AuditLogNegocio`; no elimina el cierre ni su detalle histórico.

**`Ingreso`** — `id, obra_id, concepto, fecha_estimada, fecha_real, monto, estado [cobrado|por_cobrar], creado_por, creado_en`

**`Subcontrato`** — `id, obra_id, subcontratista, concepto, alcance, monto_contratado, creado_en`

**`SubcontratoPago`** — `id, subcontrato_id, fecha, monto, gasto_id_vinculado (nullable), creado_por, creado_en`

## 5. Bitácoras y sesión

**`AuditLogNegocio`** — `id, entidad, entidad_id, accion [crear|editar|eliminar], usuario_id, canal [web|whatsapp], detalle_json, timestamp`

**`ToolCallLog`** — `id, usuario_id, telefono, tool_name, parametros_json, resultado [ejecutado|rechazado_permiso|error], modelo_usado, tokens_usados, costo_estimado, timestamp`

**`WhatsAppSession`** — `id, telefono, user_id, estado_conversacion, contexto_json, expira_en, creado_en, actualizado_en`
- `expira_en` implementa la expiración de 1 hora.
