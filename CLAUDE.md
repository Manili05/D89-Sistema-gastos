# CLAUDE.md — Orquestación del proyecto D89

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
- Commits: `[fase][módulo] descripción` (ej. `[fase1][neodata] parser de áreas y clases`).
