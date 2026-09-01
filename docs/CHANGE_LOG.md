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

---
*Cualquier desviación nueva de alcance detectada durante el desarrollo debe agregarse aquí,
siguiendo el mismo formato: naturaleza del cambio, si fue acordado con el cliente o es decisión
interna, y su impacto.*
