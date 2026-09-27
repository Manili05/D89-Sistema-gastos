# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Orquestación del proyecto D89

Sistema de Control de Gastos y Presupuesto de Obra para el Arq. Sergio Gómez (D89),
desarrollado por EscalaLeads. Metodología: Spec-Driven Development.

**Lee siempre en este orden antes de actuar:**
1. `constitution.md` — principios no negociables y riesgo de negocio aceptado.
2. `specs/001-control-gastos-obra/spec.md` — alcance funcional completo.
3. `specs/001-control-gastos-obra/plan.md` — arquitectura, catálogo de tools, flujo conversacional.
4. `specs/001-control-gastos-obra/data-model.md` — esquema de datos.
5. `specs/001-control-gastos-obra/tasks.md` — plan de fases y pruebas.
6. `docs/OPEN_QUESTIONS.md` — pendientes que NO deben resolverse por supuesto propio.

## Stack (resumen)
Next.js 16.2.11 (frontend) · FastAPI/Python (backend) · Supabase self-hosted
(Postgres+Auth+Storage, sin Studio/Realtime permanentes) · Hermes Agent v2026.6.5
(self-hosted, canal WhatsApp) · LiteLLM v1.83.x (alias `kimi-k3`, presupuesto mensual máximo
de $1,000 MXN) · Playwright 1.61.x · Docker Compose · Caddy detrás del Nginx del host.

## Sub-agentes (`.claude/agents/`)
| Agente | Cuándo usarlo |
|---|---|
| `database-agent` | Esquema, migraciones, seeds |
| `neodata-import-agent` | Parser de Excel NEODATA — mayor riesgo técnico del proyecto |
| `backend-agent` | API/lógica de negocio, auth, variación, exportación (todo lo que no sea NEODATA) |
| `frontend-agent` | Pantallas, Portal Admin, dashboard |
| `whatsapp-agent` | Configuración de Hermes Agent, tools, flujo conversacional |
| `qa-agent` | Revisión y pruebas antes de cerrar fase |
| `devops-agent` | Docker, deploy, backups, CI/CD |

## Reglas de orquestación (obligatorias)

1. Sigue el orden de `tasks.md` (Fase 0 → 1 → 2 → 3 → 4 → 5). **El parser de NEODATA es Fase 1**,
   antes que el núcleo web — es la pieza de mayor riesgo y conviene descubrir sus problemas pronto.
2. **El permiso siempre se valida en FastAPI, nunca en el agente de IA.** Ningún agente de
   desarrollo debe implementar una tool de Hermes Agent que confíe en que el modelo "sabrá" no
   usarla — el rechazo debe ocurrir del lado del servidor, siempre.
3. Toda entrega de `backend-agent`, `frontend-agent`, `neodata-import-agent` o `whatsapp-agent`
   pasa por `qa-agent` antes de considerarse terminada.
4. `eliminar_gasto` e `importar_presupuesto_neodata` **nunca** se exponen como tools de WhatsApp
   — si algún agente propone lo contrario, deténte y confírmalo con el usuario antes de proceder.
5. Toda captura de gasto vía WhatsApp requiere resumen + confirmación explícita, sin excepción —
   no lo relajes "para mejorar la experiencia", es una regla dura de `constitution.md`.
6. Si una tarea parece requerir algo de la sección "Fuera de alcance" de `spec.md`, o algo que
   `docs/OPEN_QUESTIONS.md` marca como pendiente sin resolver (ej. credenciales reales de Meta o
   fecha del VPS final de D89), **detente y pregunta al usuario** — no
   rellenes esos huecos con un supuesto silencioso.
7. Registra cualquier desviación de alcance nueva en `docs/CHANGE_LOG.md`, distinguiendo si fue
   acordada con el cliente o si es una decisión interna de EscalaLeads (ver `constitution.md`
   sección 2 para el criterio).
8. No inventes credenciales, tokens ni datos de producción — usa `.env.example` con placeholders.

## Convenciones de código
- Python: tipado estricto (type hints), validación de entrada con `pydantic` en cada endpoint.
- TypeScript: estricto, sin `any` salvo justificación explícita en comentario.
- Lógica de negocio en `services/` del backend, reutilizable entre la app web y Hermes Agent.
- Commits: Conventional Commits estrictos, `tipo(ámbito): descripción` (ej. `feat(neodata): parser
  de áreas y clases`, `fix(closes): ...`). El formato antiguo `[fase][módulo]` ya no se usa.

## Comandos

Monorepo npm (workspace `apps/web`) + paquete Python `apps/api` en `.venv` de la raíz.
Todo se ejecuta desde la raíz del repo.

```bash
# Setup
python3 -m venv .venv && .venv/bin/pip install -e 'apps/api[dev]'
npm ci
.venv/bin/python infra/scripts/bootstrap-env.py   # genera .env
docker compose up -d                              # stack completo (perfil `whatsapp` opcional)

# API (Python)
PYTHONPATH=apps/api .venv/bin/ruff check apps/api
PYTHONPATH=apps/api .venv/bin/pytest apps/api/tests -q
PYTHONPATH=apps/api .venv/bin/pytest apps/api/tests/test_neodata.py::<nombre_test> -q   # un test
D89_RUN_FINANCIAL_INTEGRATION=1 PYTHONPATH=apps/api .venv/bin/pytest \
  apps/api/tests/test_financial_security_integration.py apps/api/tests/test_weekly_close_integration.py
  # integración: levanta servicios Docker desechables; sin la variable se hace skip

# Web
npm run dev          # Next en 127.0.0.1:3000
npm run lint         # --max-warnings=0
npm run typecheck
npm run build

# Contrato API → cliente TS (obligatorio tras cambiar modelos/rutas de FastAPI; CI usa check:client)
npm run generate:client   # exporta docs/openapi.json y regenera apps/web/lib/api.generated.ts

# E2E (Playwright, proyectos desktop-chromium y mobile-chromium)
npm run test:e2e                                           # arranca `npm run dev` si no hay base URL
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3089 npm run test:e2e # contra staging local (Caddy)
npx playwright test -g "<título>" --project=desktop-chromium
```

Los tests de NEODATA que requieren el Excel real hacen skip si el libro no está en el directorio
padre (`/var/www/Apparquitectos`, fuera de Git). Los scripts `infra/scripts/verify-live-*.py`
ejercitan el staging real.

## Arquitectura

- **Flujo de datos**: navegador → Nginx (host) → Caddy (`127.0.0.1:3089`) → `web` (Next) y
  `/api/v1` (FastAPI); Supabase Auth/Storage/PostgREST comparten el mismo origen público
  (`apps/web/lib/auth.ts` crea el cliente Supabase con `window.location.origin`).
- **Frontend (`apps/web`)**: App Router. Las páginas bajo `app/obras/[workId]/*` son envoltorios
  delgados que renderizan `components/work-workspace.tsx` con un `tab`; la lógica de UI vive en
  `components/`. Las llamadas a la API pasan por `apiFetch`/`apiJson` (`lib/auth.ts`), que añaden
  el JWT de Supabase. Tipos del backend: `lib/api.generated.ts` (generado, no editar a mano).
- **Backend (`apps/api/app`)**: `api/routes.py` define todos los endpoints bajo `/api/v1`;
  `models.py` contiene los modelos pydantic; `services/` tiene la lógica de negocio.
  `services/repository.py` usa SQL crudo con psycopg (sin ORM) dentro de `transaction(settings)`,
  y cada operación revalida permisos con `require_active_profile` / `require_work_access`
  (rol del JWT `app_metadata` debe coincidir con `perfil_usuario`; acceso por `usuario_obra`).
- **Auth** (`core/security.py`): usuarios web con JWT Supabase (`CurrentUser`, `AdminUser`);
  Hermes con HMAC (`X-D89-Key-Id`, `-Timestamp`, `-Nonce`, `-Signature`, `-Actor-Phone`).
- **Hermes/WhatsApp**: catálogo de tools en `services/tools.py` (`ToolDefinition` con roles,
  `mutates`, `requires_confirmation`), expuesto en `/api/v1/hermes/tools` y ejecutado vía
  `POST /api/v1/hermes/tools/{tool_name}`. Hermes y LiteLLM solo corren con el perfil Compose
  `whatsapp`.
- **Base de datos**: migraciones SQL en `supabase/migrations/` (prefijo `YYYYMMDDNNNN_`), deben ser
  idempotentes. El servicio Compose `migrate` las aplica en orden y registra cada una en
  `public.d89_schema_migrations`; nunca edites una migración ya aplicada, crea una nueva. RLS
  además bloquea inserciones directas por REST: las escrituras deben pasar por FastAPI.
- **NEODATA** (`services/neodata.py`): parser de presupuestos Excel con jerarquía áreas/clases;
  ver `docs/NEODATA_ANALYSIS.md` y `docs/EXPENSE_HIERARCHY.md`.
- **Arquitectura documentada**: `docs/architecture/d89.architecture.json` es la fuente; tras
  editarla ejecuta `npm run archify:validate` y `npm run archify:build`.
- Hallazgos de revisión pendientes de implementar: `plans/REVIEW-2026-09-18.md`.
