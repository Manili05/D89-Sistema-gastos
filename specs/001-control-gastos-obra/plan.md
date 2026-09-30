# Plan técnico — Sistema de Control de Gastos y Presupuesto de Obra (D89)

Ver `constitution.md` (principios) y `spec.md` (alcance funcional). Este documento es la
fuente de verdad de la arquitectura.

## 1. Stack

| Capa | Tecnología | Notas |
|---|---|---|
| Frontend | Next.js 16.2.x (TypeScript, App Router) | Mobile-first para captura en campo; escritorio para dashboard/admin |
| Backend | **FastAPI (Python)** | Lógica de negocio, autenticación, validación de permisos, endpoints que Hermes Agent invoca como tools |
| Base de datos | **Supabase self-hosted** (Postgres + GoTrue/Auth + PostgREST + Storage) en el mismo VPS | **Studio y Realtime NO corren permanentemente** (ahorro de RAM; se levantan bajo demanda vía túnel SSH si se necesitan) |
| Agente WhatsApp | **Hermes Agent v2026.6.5** (self-hosted) | Gateway multi-canal, consume modelo vía LiteLLM, no aloja modelo localmente |
| AI Gateway | **LiteLLM v1.83.x** | Alias `kimi-k3`, proveedor intercambiable y tope mensual de $1,000 MXN |
| Proxy/TLS | Nginx del host → Caddy | Nginx publica `d89.escalaleads.com.mx`; Caddy escucha solo en `127.0.0.1:3089` |
| Contenedores | Docker Compose | Un solo `docker-compose.yml` orquesta todo |
| Exportación | `openpyxl` (Excel) + PDF server-side en FastAPI | Un servicio de cálculo alimenta web y archivos |
| Pruebas E2E | Playwright 1.61.x | Escritorio y móvil; screenshot al fallar, trace y video al reintentar |
| Backups | cron + `pg_dump` + comprobantes cifrados a Backblaze B2 | Diario, retención 14 días, restauración mensual |

## 2. Presupuesto de recursos (VPS 8GB)

| Componente | RAM aprox. |
|---|---|
| Postgres + GoTrue + PostgREST + Storage (Supabase lean) | 1.5–2GB |
| FastAPI | 300–400MB |
| Next.js | 300–400MB |
| Caddy | ~50MB |
| Hermes Agent (gateway, sin modelo local) | 300–500MB |
| LiteLLM | 200–300MB |
| **Total** | **~2.7–3.6GB de 8GB** — colchón amplio, incluso si se prende Studio ocasionalmente |

## 3. Diagrama de componentes

```
Excel NEODATA ──▶ Portal Admin (Next.js) ──▶ FastAPI ──▶ Supabase (Postgres)
                                                 ▲
WhatsApp Cloud API ──▶ Hermes Agent (self-hosted) │  (tool calls, validados SIEMPRE en FastAPI)
                              │                    │
                              ▼                    │
                          LiteLLM (AI Gateway) ─────┘
                              │
                              ▼
                  Proveedor LLM (intercambiable: DeepSeek/Kimi/Claude/GPT)

FastAPI ──▶ AuditLogNegocio (Postgres)     LiteLLM/Hermes ──▶ ToolCallLog (Postgres)
```

Diagrama visual completo generado y aprobado durante la sesión de arquitectura (Excalidraw).

## 4. Catálogo de diez tools del agente (fuente de verdad)

| Tool | Qué hace | Rol permitido | Condición |
|---|---|---|---|
| `registrar_gasto` | Captura gasto completo + foto | operativo (obras asignadas), admin | Siempre requiere resumen + confirmación explícita |
| `consultar_presupuesto_restante` | Presupuesto restante por partida/obra | operativo (asignadas), admin | — |
| `consultar_variacion_obra` | Presupuesto vs. real + semáforo de una obra | operativo (asignadas), admin | — |
| `editar_gasto_propio` | Corrige un gasto propio | operativo, admin | Solo mientras `estado=pendiente` |
| `registrar_ingreso_cobro` | Alta de ingreso/cobro | admin (delegable) | — |
| `consultar_flujo_caja` | Proyección de flujo de caja de una obra | **solo admin** | — |
| `registrar_pago_subcontrato` | Vincula pago de subcontrato a gasto | admin | — |
| `consultar_dashboard_agencia` | Vista consolidada de todas las obras | **solo admin** | — |
| `listar_mis_obras` | Obras asignadas al usuario que escribe | operativo, admin | — |
| `exportar_reporte` | Genera Excel/PDF de una obra | admin (y operativo de sus obras, si se habilita) | — |

Las operaciones web `eliminar_gasto` e `importar_presupuesto_neodata` no son tools de Hermes.

**Regla dura:** el permiso se valida siempre en FastAPI antes de ejecutar cualquier tool, nunca
solo porque el modelo "decidió" no ofrecerla. Cada intento (ejecutado, rechazado por permiso,
o error) se registra en `ToolCallLog`.

No se habilitan capacidades generales por defecto. Su evolución hasta una suite general está
gobernada por `docs/HERMES_CAPABILITY_ROADMAP.md`, con aprobación, presupuesto y threat model por
capacidad.

## 5. Flujo conversacional (WhatsApp) — casos de referencia

1. **Captura completa:** extrae datos → pregunta lo que falte/ambiguo → **siempre** arma resumen
   y espera "sí" → solo entonces llama `registrar_gasto`.
2. **Número no registrado:** no ejecuta ninguna tool; indica que pida alta al admin.
3. **Consulta:** llama la tool de consulta correspondiente, respeta permisos por rol.
4. **Permiso rechazado:** FastAPI rechaza, el agente lo comunica sin exponer detalles internos;
   se registra en `ToolCallLog` como `rechazado_permiso`.
5. **Edición:** permitida solo si `estado=pendiente`; si ya es `validado`, remite a la web.
6. **Sesión abandonada:** expira a la 1 hora sin respuesta; un recordatorio único antes de
   expirar; nunca se guarda un gasto a medias.

## 6. Flujo de importación NEODATA — implementación

Ver `spec.md` sección 4.2 para el detalle funcional completo. Puntos de implementación:
- El parser vive en el backend (FastAPI), invocado únicamente desde un endpoint que solo el
  Portal Admin consume.
- `ImportacionNeodata.preview_json` es la única escritura hasta la confirmación — nada más se
  toca en las tablas de negocio antes de ese punto.
- La detección de duplicado de obra (nueva_version vs extra) ocurre **antes** de mostrar el
  preview normal — es un paso bloqueante propio.

## 7. Despliegue

- **Actual (desarrollo):** VPS y dominio de EscalaLeads.
- **Pendiente antes de producción real:** migrar a VPS/dominio propio de D89 (Hostinger a
  nombre del cliente, según cotización original). El `docker-compose.yml` y las variables de
  entorno deben mantenerse agnósticas de dominio (todo vía `.env`) para que esta migración sea
  un cambio de configuración, no de código.
- CI/CD: build + lint + test en cada push (GitHub Actions); deploy manual o automático por SSH.

## 8. Seguridad

- Sesión de usuario + rol validados en cada endpoint.
- Autenticación servicio a servicio Hermes→FastAPI mediante HMAC-SHA256. La firma cubre método,
  ruta, timestamp, nonce y SHA-256 del cuerpo; FastAPI aplica ventana de cinco minutos y rechaza
  nonces repetidos. El secreto es exclusivo del servicio y vive únicamente en variables secretas.
- El agente de WhatsApp nunca tiene credenciales directas de base de datos — todo pasa por los
  endpoints de FastAPI con su propia validación de permiso.
