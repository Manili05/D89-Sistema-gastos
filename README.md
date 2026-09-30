# D89 · Sistema de gastos

Monorepo de control de presupuesto, gastos y cierres de obra de Distrito 89.
El staging combina Next.js, FastAPI, PostgreSQL/Supabase self-hosted y Caddy;
Nginx es la única entrada pública del VPS.

## Componentes

- `apps/web`: interfaz responsive Next.js 16.2.
- `apps/api`: API `/api/v1`, OpenAPI, parser NEODATA y reportes server-side.
- `supabase`: migraciones idempotentes, RLS, Auth y bucket privado.
- `infra`: Compose, Caddy, Nginx, Hermes/LiteLLM y respaldos cifrados.
- `tests`: Playwright desktop/móvil; las unitarias API viven junto a la app.

## Desarrollo

```bash
python3 -m venv .venv
.venv/bin/pip install -e 'apps/api[dev]'
npm ci
.venv/bin/python infra/scripts/bootstrap-env.py
docker compose up -d
```

El Excel NEODATA real se mantiene en el directorio padre y está excluido de
Git. Para regenerar contrato y cliente TypeScript:

```bash
npm run generate:client
```

## Verificación

```bash
PYTHONPATH=apps/api .venv/bin/ruff check apps/api
PYTHONPATH=apps/api .venv/bin/pytest apps/api/tests -q
npm run lint
npm run typecheck
npm run check:client
npm run build
PLAYWRIGHT_BASE_URL=http://127.0.0.1:3089 npm run test:e2e
```

Los scripts `verify-live-flow.py` y `verify-live-reports.py` ejercitan el
staging real sin imprimir secretos. `provision-staging-admin.py` es idempotente.
`verify-live-auth.py` comprueba el correo de recuperación, el cambio de
contraseña, el nuevo login y el cierre de sesión contra Auth real; Mailpit se
mantiene únicamente en la red interna para pruebas de staging.

Antes de habilitar el perfil `whatsapp`, captura en `.env` un tipo de cambio
contable aprobado y su fecha. Después ejecuta
`infra/scripts/provision-litellm-budget.py`: crea una clave virtual limitada al
alias `kimi-k3`, convierte hacia abajo el tope de $1,000 MXN a USD y entrega a
Hermes esa clave; la clave maestra de LiteLLM nunca se comparte con Hermes.

## Operación y seguridad

- Solo Caddy publica `127.0.0.1:3089`; Nginx enruta el dominio D89.
- Los roles se leen de `app_metadata` firmado y se revalidan contra
  `perfil_usuario`; el acceso operativo se limita por `usuario_obra`.
- Hermes usa HMAC con timestamp y nonce y nunca conecta directamente a la BD.
- Importación y eliminación no son tools de WhatsApp.
- `.env`, libros Excel, evidencias y respaldos nunca se versionan.

Consulta [estado de staging](docs/STAGING_STATUS.md),
[evidencia NEODATA](docs/NEODATA_ANALYSIS.md) y
[restauración de servicios heredados](infra/RESTORE_DISABLED_SERVICES.md).
