# Change Log — Desviaciones respecto a la cotización original (EL-COT-2026-001)

## Contexto base
Cotización original: $12,528 MXN (IVA incluido), depósito $7,000 MXN, 8 semanas de plazo,
alcance de monolito simple sin importación automática de Excel ni agente de IA.

## Cambio 1 — Importación de presupuesto desde NEODATA
- **Naturaleza:** cambio de alcance **funcional**, renegociado explícitamente con el cliente
  (Arq. Sergio Gómez). La cotización original lo listaba como "fuera de alcance" ("la carga del
  presupuesto base es manual en la V1").
- **Estado comercial:** el usuario (EscalaLeads) confirmó que esto ya fue conversado y aceptado
  con el cliente. No se cuenta con el documento formal de esa conversación al momento de generar
  estos artefactos — queda como pendiente documental, no como bloqueante técnico.

## Cambio 2 — Arquitectura técnica (microservicios + capa de IA)
- **Naturaleza:** decisión de **ingeniería interna de EscalaLeads**, no algo que el cliente pidió
  ni pagó de forma diferenciada. Incluye: separación Next.js/FastAPI, Supabase self-hosted
  completo, Hermes Agent como framework de agente conversacional, LiteLLM como AI Gateway.
- **Motivo:** necesario para soportar el Cambio 1 (parser complejo con versionado) y la captura
  conversacional vía WhatsApp con calidad aceptable.

## Cambio 3 — Presupuesto y plazo: riesgo aceptado, sin ajuste
- **Decisión explícita del usuario (EscalaLeads), confirmada en sesión de arquitectura:**
  mantener el mismo monto ($12,528 MXN) y plazo (8 semanas) de la cotización original, **a pesar**
  de que la complejidad de ingeniería real (Cambios 1 y 2 combinados) excede considerablemente lo
  que esa cotización fue diseñada para cubrir.
- **Esto no es un error de planeación de EscalaLeads ni de este documento** — es una decisión de
  negocio consciente. Se documenta aquí para que quede visible y no se repita como sorpresa más
  adelante en el proyecto.

## Cambio 4 — Infraestructura de desarrollo
- El VPS y dominio usados para desarrollo son de **EscalaLeads**, no de D89. La cotización
  original asumía "Servidor VPS (Hostinger u equivalente)... por cuenta del cliente". D89 aún no
  tiene su propia infraestructura contratada.
- **Pendiente:** plan de migración a infraestructura propia de D89 antes de la entrega final en
  producción (ver `docs/OPEN_QUESTIONS.md` y `plan.md` sección 7).

## Cambio 5 — Decisiones técnicas cerradas para ejecución 2026-08-28
- **Stack fijado:** Next.js 16.2.x, Playwright 1.61.x, Hermes v2026.6.5 y LiteLLM v1.83.x.
- **Identidad:** Supabase Auth es la única fuente de contraseñas; `perfil_usuario` extiende
  `auth.users` y no duplica `password_hash`.
- **LLM:** alias LiteLLM `kimi-k3`, con presupuesto máximo mensual de $1,000 MXN.
- **Servicio a servicio:** HMAC-SHA256 con timestamp y protección contra replay entre Hermes y
  FastAPI; no API key estática sin firma.
- **Reportes:** Excel se genera con `openpyxl` y PDF desde FastAPI.
- **Backups:** Backblaze B2 cifrado, ejecución diaria, retención de 14 días y restauración mensual.
- **Operación:** este VPS se dedica a desarrollo/staging; producción se moverá al VPS final de
  D89 mediante configuración.
- **WhatsApp:** se exponen exactamente diez tools de negocio. Importar presupuesto y eliminar
  gasto permanecen exclusivamente en la web.

## Cambio 6 — Captura inteligente: extracción de CSF y comprobantes con IA (2026-09-27)
- **Naturaleza:** cambio de alcance **funcional**, **acordado con el cliente**. No figuraba en
  la sección 4 de `spec.md`.
- **Qué incluye:**
  - `POST /api/v1/suppliers/extract-csf` (sólo admin): lee la Constancia de Situación Fiscal
    (PDF) y propone RFC, razón social, régimen fiscal y código postal.
  - `POST /api/v1/expenses/extract-receipt`: lee la foto de un ticket o nota de remisión y
    propone total, conceptos (cantidad, precio unitario, descripción) y la bandera
    `requiere_validacion_humana`.
  - `POST /api/v1/expenses/jev-chat` ("Árbitro Jev", alias `d89-documentos`, sólo texto):
    aplica correcciones en lenguaje natural a la lectura del ticket. El formulario de gasto
    muestra la lectura y el chat; el usuario decide si copia los valores o captura a mano, y
    la foto se vincula como comprobante al guardar.
- **Límites (constitution §3):**
  - Las extracciones sólo **proponen**: no escriben proveedores ni gastos.
  - FastAPI revalida el esquema y recalcula la suma de conceptos. La bandera de revisión humana
    sólo puede endurecerse en el servidor, nunca relajarse.
  - Cada llamada queda en `tool_call_log` (modelo, tokens, costo y resultado) sin el contenido
    del documento.
- **Modelos:** por alias configurable de LiteLLM.
  - `d89-documentos` → `gemini-3.5-flash-lite`, con respaldo `gemini-3.6-flash` y luego
    `claude-sonnet-5`.
  - `d89-vision` → `gemini-3.8-flash`, con respaldo `gemini-3.6-flash` y luego
    `claude-sonnet-5` (respaldo intermedio agregado el 2026-09-28 tras observar 503
    "high demand" en `gemini-3.8-flash`).
  - `claude-opus-5-5` queda registrado fuera de las cadenas automáticas por costo.
- **Impacto operativo:**
  - LiteLLM pasa a estar siempre encendido (antes sólo con el perfil `whatsapp`), con unos
    512 MB de RAM en el VPS.
  - Hermes y la extracción comparten **un solo** tope mensual de $1,000 MXN mediante un equipo
    de LiteLLM con dos claves virtuales (`provision-litellm-budget.py`).
  - Se requieren `GEMINI_API_KEY` y `ANTHROPIC_API_KEY`.
- **Deuda técnica pagada en el mismo cambio:**
  - `/gastos` usa ahora el mismo formulario que `/obras/[id]/gastos`, que no duplica gastos al
    reintentar el comprobante.
  - Vincular un comprobante exige que el archivo exista en Supabase Storage.

## Cambio 7 — Gasto cabecera-detalle, folio automático y comprobantes múltiples (2026-09-28)
- **Naturaleza:** cambio de alcance **funcional**, **acordado con el cliente** (nuevos
  requerimientos de captura).
- **Qué cambia:**
  - Un gasto pasa de un solo concepto a **cabecera + N conceptos** (`gasto_concepto`:
    cantidad, unidad, descripción, precio unitario, descuento e importe).
  - Se agregan **N comprobantes por gasto** (`gasto_comprobante`: PDF, XML CFDI e imagen).
  - **Folio automático** `G-00001` (secuencia global). El folio capturado del proveedor
    pasa a `folio_proveedor`.
- **Regla de IVA acordada:** los precios se capturan **con IVA incluido**.
  - `importe` (total) = Σ conceptos.
  - Sin IVA explícito: `subtotal = importe / 1.16`.
  - Un IVA explícito (exento, frontera 8 %) se acepta entre 0 y el 16 % contenido en el total.
  - El servidor calcula todos los totales; no acepta los del cliente.
- **Migración de datos:** los gastos previos quedan con **IVA no desglosado**
  (`subtotal = importe`, `iva = 0`, `iva_desglosado = false`), 1 concepto y folio asignado
  por fecha de captura. `gasto.importe` sigue siendo el total, así que cierres, presupuesto
  y reportes no cambian.
- **Fase 2 (2026-09-28):**
  - El formulario de gasto captura N conceptos con cálculo en vivo idéntico al servidor,
    marca los conceptos exentos y adjunta varios comprobantes.
  - Lector de **CFDI XML** sin IA (`POST /api/v1/expenses/extract-xml`): emisor, conceptos
    e impuestos; propone los renglones del gasto y cruza el RFC con el directorio.
  - **Alta rápida de proveedor** desde el gasto (sólo admin), asignado a la obra en la misma
    transacción.
  - PostgREST queda de **sólo lectura** para `gasto`, `gasto_concepto` y
    `gasto_comprobante`: toda mutación pasa por FastAPI.

---
*Cualquier desviación nueva de alcance detectada durante el desarrollo debe agregarse aquí,
siguiendo el mismo formato: naturaleza del cambio, si fue acordado con el cliente o es decisión
interna, y su impacto.*
