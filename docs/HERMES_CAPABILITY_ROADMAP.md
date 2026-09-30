# Hermes Capability Roadmap — D89

## Estado V1

Hermes v2026.6.5 expone exactamente diez tools de negocio. Todas llaman `/api/v1`, se firman
con HMAC-SHA256 y vuelven a validar usuario, rol y obra en FastAPI. No hay acceso directo a
Postgres. `eliminar_gasto` e `importar_presupuesto_neodata` son operaciones web y jamás se
publican al modelo.

## Evolución controlada

1. **Observabilidad:** medir éxito, rechazos, tokens y costo por tool en `ToolCallLog`.
2. **Asistencia de documentos:** búsqueda de comprobantes y reportes ya autorizados, sin escritura.
3. **Automatización administrativa:** nuevas tools con schema cerrado, idempotencia y confirmación.
4. **Suite general:** capacidades no financieras solo después de threat model, presupuesto,
   allowlist de red, sandbox y aprobación explícita del responsable de D89.

## Gate obligatorio por capacidad

- caso de negocio y rol permitido;
- datos a los que accede y periodo de retención;
- costo máximo y modelo autorizado vía alias LiteLLM;
- riesgo de prompt injection/exfiltración y mitigación;
- pruebas de permisos, auditoría, idempotencia y rollback;
- aprobación documentada antes de habilitarla en staging o producción.
