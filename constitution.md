# Constitution — Sistema de Control de Gastos y Presupuesto de Obra (D89)

Este documento fija los principios no negociables del proyecto. Todo `spec.md`, `plan.md`,
`tasks.md` y agente debe ser consistente con esto. Si algo entra en conflicto, este documento gana.

## 1. Identidad del proyecto

- **Cliente:** Arq. Sergio Edgar Gómez Villaseñor — despacho de arquitectura, marca interna "D89".
- **Proveedor:** EscalaLeads (Zapopan, Jalisco).
- **Base contractual:** Cotización EL-COT-2026-001 (8 de junio de 2026), $12,528 MXN total,
  depósito $7,000 MXN, 8 semanas de plazo.
- **Tenancy:** single-tenant. D89 es el único despacho que usará el sistema — **no** se modela
  una entidad "Agencia/Tenant" separada de "Obra"; D89 es simplemente el nombre del despacho.

## 2. Riesgo de negocio aceptado (léase antes de tocar código)

El alcance real de este proyecto (importación NEODATA con versionado, agente de IA conversacional
vía WhatsApp, arquitectura de microservicios, Supabase self-hosted) **excede considerablemente**
la complejidad que sustenta la cotización original de $12,528 MXN / 8 semanas, pensada para un
monolito simple. **EscalaLeads decidió conscientemente absorber este riesgo y mantener el mismo
monto y plazo.** Esto no es un error de planeación — es una decisión de negocio documentada.
Ningún agente debe "corregir" esto proponiendo recotizar sin que el usuario lo pida.

Distinción importante para `docs/CHANGE_LOG.md`:
- La **importación de NEODATA** sí fue renegociada explícitamente con el cliente como cambio de
  alcance funcional.
- La **arquitectura técnica** (FastAPI, microservicios, Hermes Agent, LiteLLM, Supabase
  self-hosted) es una decisión de ingeniería de EscalaLeads para construir ese alcance — no fue
  algo que el cliente pidió ni pagó aparte. Se absorbe dentro del mismo presupuesto como parte del
  riesgo aceptado.

## 3. Principios de arquitectura

1. **Un solo entorno autocontenible por Docker Compose**, corriendo en el VPS de Hostinger.
   Nada de servicios externos de pago no justificados explícitamente.
2. **El permiso siempre se valida en el backend (FastAPI), nunca se confía en lo que el modelo de
   IA decide.** Ningún agente de IA tiene autoridad de negocio por sí mismo — solo propone,
   FastAPI dispone.
3. **Dos bitácoras separadas y con propósitos distintos:**
   - `AuditLogNegocio`: trazabilidad financiera (quién hizo qué a qué gasto/obra).
   - `ToolCallLog`: uso y costo del agente de IA (qué modelo, cuántos tokens, qué tool, resultado).
   No se mezclan.
4. **La importación de NEODATA y la administración de catálogos son operaciones exclusivas de
   la app web, con permiso de administrador.** El agente de WhatsApp nunca las ejecuta ni las
   conoce como capacidad disponible.
5. **Toda captura de gasto vía WhatsApp requiere confirmación explícita del usuario** (resumen +
   "sí/no") antes de escribir a base de datos, sin excepción, incluso si el agente está seguro de
   los datos extraídos.
6. **El modelo de IA detrás de LiteLLM es intercambiable por configuración**, nunca hardcodeado
   en el código del agente ni del backend.
7. **Nada se importa/compromete a base de datos sin preview editable y confirmación humana**
   cuando el origen es un archivo externo (NEODATA) — la inconsistencia real observada en los
   archivos de NEODATA hace que el parseo 100% automático sea inaceptable.

## 4. Fuentes de verdad

- Alcance funcional → `specs/001-control-gastos-obra/spec.md`
- Arquitectura técnica → `specs/001-control-gastos-obra/plan.md`
- Modelo de datos → `specs/001-control-gastos-obra/data-model.md`
- Plan de construcción por fases → `specs/001-control-gastos-obra/tasks.md`
- Desviaciones de la cotización original → `docs/CHANGE_LOG.md`
- Decisiones aún pendientes (no bloqueantes, pero deben resolverse) → `docs/OPEN_QUESTIONS.md`
- Reglas de orquestación para agentes de Claude Code → `CLAUDE.md`
