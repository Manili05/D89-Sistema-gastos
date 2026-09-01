# Spec — Sistema de Control de Gastos y Presupuesto de Obra (D89)

Ver `constitution.md` para principios no negociables y riesgo de negocio aceptado.

## 1. Problema y objetivo

Sergio (D89) controla gastos de obra en hojas de cálculo: captura manual, sin registro ágil desde
campo, sin comprobantes adjuntos, sin visibilidad rápida de presupuesto vs. real. El sistema
reemplaza esto con una app web (mobile-first) + un canal conversacional por WhatsApp, con
importación directa del presupuesto base desde el Excel que ya genera NEODATA.

## 2. Usuarios y roles

| Rol | Cantidad | Alcance |
|---|---|---|
| Administrador | 1 | Todas las obras, catálogos, importación NEODATA, configuración de permisos, umbrales de variación, eliminar gastos |
| Operativo | 9 | Solo las obras que tenga asignadas (`UserObra`); captura y consulta, sin catálogos ni importación |

## 3. Jerarquía de datos

**D89 (implícito, single-tenant) → Obra → Área → Clase → Categoría (opcional) → Partida (presupuesto) / Gasto (real)**

- `Área` es una entidad real y navegable (confirmado con el Excel real de NEODATA: una obra
  puede traer varias áreas, ej. Oficina / Comedor / Baños, cada una con su propio presupuesto).
- `Categoría` solo existe bajo la Clase "Instalaciones" (Hidráulicas/Sanitarias/Eléctricas), el
  resto de Clases va directo a Partida.

## 4. Alcance funcional

### 4.1 Gestión de obras y presupuesto base
- CRUD de obras (nombre, ubicación, fechas, responsable).
- **Importación automatizada del presupuesto desde Excel de NEODATA** (ver sección 4.2)
  — cambio de alcance renegociado explícitamente con el cliente (ver `docs/CHANGE_LOG.md`).
- Carga/edición manual como respaldo (posibilidad de agregar partidas/categorías sobre la marcha,
  **solo desde la app web**, nunca desde WhatsApp).
- Catálogos maestros de agencia (únicos, no por obra): Clase, Categoría, Partida, Proveedor.
  **Solo el administrador los edita.**

### 4.2 Importación NEODATA (detallado)

1. Disparo solo desde el Portal Admin (web). Se procesan **todas las hojas del archivo
   automáticamente**.
2. Parseo heurístico: detecta encabezado de Área (patrón inconsistente — requiere heurística, no
   una regla fija), encabezado de Clase (columna A == columna B), Categoría (solo dentro de
   Instalaciones), filas de Partida (código + datos numéricos), filas de continuación de
   descripción (sin código), filas TOTAL (cierre de sección).
3. Validación cruzada: recalcula el subtotal de cada sección y lo compara contra el TOTAL que
   trae el propio Excel. Discrepancias se muestran como advertencia, nunca se “corrigen” solas.
4. **Preview editable obligatorio** antes de cualquier escritura en base de datos — nada se
   compromete hasta que el admin confirme.
5. **Re-importación de una obra ya importada:** el sistema detecta el duplicado y obliga a elegir
   explícitamente:
   - **Nueva versión** (reemplaza): la versión anterior pasa a histórica (`vigente=false`), la
     nueva queda activa (`vigente=true`). Los gastos ya capturados no se borran.
   - **Extra** (se suma): se agregan partidas nuevas sin tocar las existentes, que siguen vigentes.
6. **Ítems de catálogo nuevos** (partida, proveedor, clase, categoría no existentes en el
   catálogo de agencia) se muestran en **un aviso único agregado** al final del preview, con
   confirmación en un solo clic — nunca uno por uno. Solo visible/accionable por el admin.
7. Filas que el parser no puede clasificar con confianza se marcan `no_clasificado` y requieren
   asignación manual — nunca se adivinan.
8. **La variación de presupuesto vs. real siempre compara contra la versión `vigente=true`**,
   sin importar la fecha en que se capturó el gasto (riesgo aceptado: el pasado se “re-evalúa”
   con el presupuesto más reciente — debe comunicarse así al cliente, no es un bug).

### 4.3 Registro de gasto real (web)
- Captura: clase, categoría (si aplica), partida, proveedor, fecha, concepto, folio, importe.
- Adjuntar foto del comprobante (cámara o galería).
- Estado: `validado` | `pendiente`. El administrador valida gastos y ejecuta un
  `CierreSemanal` por lote (semana ISO y obra). Un cierre solo puede reabrirse con motivo,
  identidad del administrador y evento de auditoría.
- Edición/eliminación con bitácora. **`eliminar_gasto` (borrado lógico) solo desde la app web**,
  solo con el permiso correspondiente (por defecto, solo admin).

### 4.4 Registro de gasto vía WhatsApp (agente conversacional)
- Framework: **Hermes Agent**, self-hosted, conectado vía webhook oficial de WhatsApp Cloud API.
- El usuario describe el gasto en lenguaje natural; el agente extrae los campos y **siempre**
  muestra un resumen y espera confirmación explícita ("¿Guardo? sí/no") antes de llamar cualquier
  tool de escritura — sin excepción, incluso si los datos parecen inequívocos.
- Si el usuario corrige en vez de confirmar, el agente actualiza el resumen y vuelve a pedir
  confirmación (no asume que una corrección es un "sí").
- Un número de WhatsApp no registrado en el sistema **no puede crear nada**; se le indica que
  pida alta al administrador.
- `editar_gasto_propio`: permitido mientras el gasto siga `pendiente`; bloqueado en cuanto pasa a
  `validado` (debe pedirse al admin vía web).
- Sesión de conversación expira a **1 hora** sin respuesta; un borador (ej. una foto sin datos)
  no se convierte en gasto guardado solo por quedar sin respuesta.
- El catálogo completo de herramientas del agente y su matriz de permisos por rol vive en
  `plan.md` sección "Catálogo de tools" — es la fuente de verdad, no debe reinterpretarse.
- Hermes expone exactamente diez tools de negocio. `eliminar_gasto` e
  `importar_presupuesto_neodata` no forman parte de su catálogo y solo existen en la app web.
- El agente puede tener, además de las tools de negocio, **capacidades generales** (no acotadas
  estrictamente) — decisión explícita del cliente/EscalaLeads de dejarlo más flexible para usos
  futuros vía WhatsApp. Ver `docs/OPEN_QUESTIONS.md` para la lista final pendiente de confirmar.

### 4.5 Control de variación (presupuesto vs. real)
- Comparación por partida y por obra, en $ y %.
- Semáforo verde/ámbar/rojo, umbrales **configurables por obra** (default: verde <10%,
  ámbar 10–25%, rojo >25%), editable **solo desde el portal admin web**.
- Vista consolidada de todas las obras activas — **solo accesible por el administrador**
  (`consultar_dashboard_agencia`); un operativo nunca ve el consolidado de agencia, solo sus
  obras asignadas.

### 4.6 Ingresos / cobros y flujo de caja
- Registro de ingresos por obra (concepto, fecha estimada, fecha real, monto).
- Cobrado vs. por cobrar; proyección de flujo de caja con saldo acumulado.
- Cortes bajo estándar de semana ISO de PostgreSQL (lunes-domingo).

### 4.7 Subcontratos
- Registro por obra (subcontratista, concepto, alcance, monto contratado).
- Pagos de subcontrato vinculados a `Gasto` (impactan la variación de la obra).

### 4.8 Dashboard de decisión
- Gasto por categoría, presupuesto vs. real, variación y semáforo.
- Indicadores por obra + consolidado de agencia (solo admin).

### 4.9 Acceso, usuarios y exportación
- Login para 10 usuarios (1 admin + 9 operativos).
- Exportación a Excel y PDF.
- Respaldo automático de datos e imágenes de comprobantes (destino externo pendiente de definir,
  ver `docs/OPEN_QUESTIONS.md`).

## 5. Fuera de alcance (V1)

- Gestión de contratos.
- Órdenes de compra / módulo de compras.
- Módulos de calidad y seguridad.
- App móvil nativa (Android/iOS) — la V1 es web responsiva.
- Roles/permisos avanzados más allá de admin/operativo (aunque el esquema `PermisoTool` es
  extensible a futuro, la V1 solo implementa estos dos roles).
- Multi-tenancy (confirmado: solo D89 usa el sistema).
- Cualquier funcionalidad no descrita explícitamente en la sección 4.

## 6. Requisitos no funcionales

- **Hosting:** VPS Hostinger, 8GB RAM. **Actualmente el VPS y dominio son de EscalaLeads**
  (para desarrollo); D89 aún no tiene su propia infraestructura — debe planearse la migración a
  infraestructura propia del cliente antes de la entrega final en producción (ver
  `docs/OPEN_QUESTIONS.md` y `plan.md` sección de despliegue).
- **Seguridad:** sesión + rol validados en cada endpoint del backend, HTTPS obligatorio,
  contraseñas hasheadas.
- **Auditoría:** cada mutación de negocio y cada tool call del agente quedan registrados
  (ver `constitution.md` sección 3.3).
- **Rendimiento:** operable con múltiples obras activas y captura concurrente de los 10 usuarios
  sin degradación perceptible.
- **Zona horaria:** se asume `America/Mexico_City` para los cortes de semana ISO — **supuesto no
  confirmado explícitamente**, ver `docs/OPEN_QUESTIONS.md`.
- **Moneda:** se asume MXN único — **supuesto no confirmado explícitamente**.

## 7. Criterios de aceptación

Ver `specs/001-control-gastos-obra/tasks.md` sección "Plan de pruebas" para la tabla completa
por módulo, con marca de qué es bloqueante para cerrar cada fase.
