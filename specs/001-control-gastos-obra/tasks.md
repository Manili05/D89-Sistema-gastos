# Tasks — Plan de construcción y pruebas

Ver `plan.md` (arquitectura) y `data-model.md` (esquema). Este documento traduce ambos en fases
ejecutables por los sub-agentes definidos en `.claude/agents/`.

**Nota de secuencia:** el parser de NEODATA se movió más temprano en el plan (Fase 1, no Fase 2)
porque es la pieza de mayor riesgo técnico identificado (headers inconsistentes, versionado,
validación cruzada) — conviene descubrir sus problemas cuanto antes, no al final.

## Fase 0 — Plataforma
Agente: `devops-agent`
- Monorepo fijo: `apps/web`, `apps/api`, `supabase`, `infra`, `tests` y `docs`.
- Scaffold Next.js 16.2.x + FastAPI + Playwright 1.61.x.
- `docker-compose.yml`: Caddy, Next.js, FastAPI, Supabase stack lean (Postgres+GoTrue+PostgREST+Storage, sin Studio/Realtime permanentes), Hermes Agent, LiteLLM.
- Repositorio Git (estado real pendiente de confirmar con el usuario — ver `docs/OPEN_QUESTIONS.md`).
- `.env.example` documentando todas las variables (incluye placeholder de dominio para que la migración futura a infraestructura de D89 sea solo config).

**Salida esperada:** health checks verdes, Caddy en `127.0.0.1:3089`, Nginx válido y CI con
lint, tipos, unitarias, integración y Playwright.

## Fase 1 — Datos + NEODATA (movida antes por riesgo)
Agentes: `database-agent`, `neodata-import-agent`, `backend-agent`
- Esquema completo de `data-model.md` + migraciones.
- Seeds: catálogos iniciales + usuario admin.
- Parser NEODATA: detección heurística de Área/Clase/Categoría/Partida, validación cruzada de
  TOTALES, manejo de filas de continuación, marcado de `no_clasificado`.
- Lógica de duplicado de obra (nueva_version vs extra) + versionado en `PresupuestoPartida`.
- Endpoint de preview (no escribe negocio) + endpoint de confirmación (commit real).
- Prueba obligatoria contra el archivo real de Toluca antes de continuar a Fase 2.
- Casos negativos: códigos repetidos, macros, enlaces externos, archivo corrupto, límite de
  tamaño y rollback transaccional.

## Fase 2 — Núcleo web
Agentes: `backend-agent`, `frontend-agent`
- Auth (login, sesiones, roles admin/operativo) + `UserObra`.
- CRUD Obras, Áreas, Catálogos (solo admin).
- Captura de gasto (web) con adjuntar comprobante.
- Cálculo de variación + semáforo (umbrales por obra vía `ConfiguracionVariacion`).
- Vista de variación por obra.
- Cierre semanal por lote y reapertura auditada.
- QA de la fase.

## Fase 3 — Agente de WhatsApp (Hermes Agent + LiteLLM)
Agente: `whatsapp-agent`
- Configuración de Hermes Agent: conexión WhatsApp Cloud API, definición de las 10 tools de
  negocio (JSON schema) apuntando a los endpoints de FastAPI.
- Integración con LiteLLM v1.83.x usando alias `kimi-k3` y tope de $1,000 MXN/mes.
- HMAC-SHA256 firmado Hermes→FastAPI; Hermes nunca recibe credenciales de Postgres.
- Implementación del flujo conversacional de `plan.md` sección 5, incluyendo confirmación
  siempre explícita y expiración de sesión a 1 hora.
- Verificación del gate de permisos: todo tool call pasa por validación de FastAPI, sin excepción.
- QA de la fase (incluye probar los 6 casos de flujo conversacional documentados).

## Fase 4 — Ingresos, subcontratos, dashboard
Agentes: `backend-agent`, `frontend-agent`
- Ingresos/cobros + flujo de caja.
- Subcontratos + pagos vinculados a gasto.
- Dashboard por obra + consolidado de agencia (solo admin).
- QA de la fase.

## Fase 5 — Exportación, backups, endurecimiento, entrega
Agentes: `backend-agent`, `devops-agent`, `qa-agent`
- Exportación Excel con `openpyxl` y PDF server-side desde los servicios de cálculo.
- Backups diarios cifrados a Backblaze B2, retención 14 días + restauración mensual real.
- Endurecimiento: validaciones, manejo de errores, verificación de permisos en cada endpoint.
- Pruebas de aceptación completas (tabla abajo).
- Checklist de migración de infraestructura EscalaLeads → D89 (dominio/VPS propio del cliente).

---

## Plan de pruebas / criterios de aceptación

### Presupuesto y NEODATA

| Criterio | Prueba | Bloqueante |
|---|---|---|
| Detecta correctamente Área > Clase > Categoría > Partida en el Excel real de Toluca | Importar el archivo real y comparar contra el conteo manual ya validado | Sí |
| Subtotal recalculado coincide con TOTAL del Excel; descuadres se muestran, no se corrigen solos | Caso real (cuadra) + Excel alterado a propósito (debe advertir) | Sí |
| Filas no clasificables se marcan `no_clasificado`, requieren asignación manual | Insertar fila atípica de prueba | Sí |
| Nada se escribe en tablas de negocio antes de "Confirmar" | Subir archivo, no confirmar, verificar tablas vacías | Sí |
| Reimportar obliga a elegir nueva_version/extra explícitamente | Importar dos veces la misma obra | Sí |
| Nueva versión marca v1 no vigente y v2 vigente; gastos previos no se borran | Import v1 → capturar gastos → reimport como nueva_version → verificar | Sí |
| Extra suma sin tocar vigencia existente | Reimport como extra, verificar v1 sigue vigente y total aumentó | Sí |
| Ítems de catálogo nuevos en un solo aviso agregado | Import con partidas/proveedores nuevos | No (UX) |
| Solo admin puede confirmar importación o editar catálogo | Intentar con usuario operativo | Sí |

### Captura de gasto (web y WhatsApp)

| Criterio | Prueba | Bloqueante |
|---|---|---|
| Gasto por WhatsApp aparece igual en web/reportes | Registrar por bot, verificar en listado web (`origen=whatsapp`) | Sí |
| Agente siempre confirma antes de guardar, sin excepción | Caso con datos inequívocos desde el primer mensaje — debe seguir pidiendo confirmación | Sí |
| Número no registrado no crea nada | Escribir desde número no dado de alta | Sí |
| `editar_gasto_propio` funciona solo mientras `pendiente` | Editar antes y después de validar | Sí |
| `eliminar_gasto` inalcanzable desde WhatsApp | Intentar vía WhatsApp (no debe existir la tool) | Sí |
| Sesión expira a la 1h sin guardar gasto a medias | Dejar resumen sin confirmar >1h | Sí |
| Todo tool call (exitoso o rechazado) queda en `ToolCallLog` | Provocar un rechazo por permisos | Sí |

### Variación y dashboard

| Criterio | Prueba | Bloqueante |
|---|---|---|
| Semáforo usa umbrales configurados por obra | Cambiar `ConfiguracionVariacion`, verificar color sin tocar código | Sí |
| Variación siempre compara contra `vigente=true` | Obra con v1 y v2, verificar gasto de v1 comparado contra v2 | Sí |
| `consultar_dashboard_agencia` solo admin | Intentar como operativo (web y WhatsApp) | Sí |
| Operativo solo ve/opera sus obras asignadas | Login operativo con una sola obra | Sí |

### Exportación y backups

| Criterio | Prueba | Bloqueante |
|---|---|---|
| Exportación refleja los mismos números que la vista en pantalla | Comparar reporte exportado vs. vista web | Sí |
| Backup diario es restaurable de verdad | Ejecutar restauración de prueba en entorno aislado | Sí |
