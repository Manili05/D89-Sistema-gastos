# Estado de staging

Última verificación: 2026-09-01 UTC.

- El tráfico entra únicamente por Caddy en `127.0.0.1:3089`; PostgreSQL,
  Supabase Auth, PostgREST, Storage, FastAPI y Next.js no publican puertos.
- UFW está activo y persistente, con entrada limitada a OpenSSH y Nginx
  (22/80/443). Los servicios Snap CUPS quedaron detenidos y deshabilitados sin
  desinstalar el paquete; el puerto 631 ya no escucha.
- Nginx conserva la configuración preparada para `d89.escalaleads.com.mx`.
- El perfil principal no arranca Hermes/LiteLLM. El perfil `whatsapp` permanece
  en sandbox hasta contar con aprobación Meta y secretos Kimi válidos.
- Los respaldos B2 y la restauración mensual están definidos, pero sus timers
  no deben habilitarse hasta provisionar credenciales B2 y una identidad age.
- La creación del primer administrador se realiza por Supabase Auth Admin API;
  nunca se inserta una contraseña en el esquema público.
- El administrador staging y la obra `Infra Toluca` están provisionados. El
  correo y la contraseña se conservan solo en `.env` (modo `0600`, fuera de Git).
- El flujo live validado incluye login, preview y confirmación de 232 partidas,
  gasto con comprobante privado, cierre, reapertura, dashboard, exportaciones
  XLSX/PDF, ingreso, subcontrato y pago vinculado.
- Hermes ya no recibe la clave maestra de LiteLLM. El provisionador crea una
  clave virtual exclusiva de `kimi-k3` con renovación mensual y convierte el
  límite de $1,000 MXN a USD usando un tipo de cambio contable explícito. No se
  habilita hasta contar con el tipo de cambio aprobado y la credencial Kimi.
- Umbral operativo: al menos 1.5 GB de memoria disponible con el stack activo.
  La medición del 1 de septiembre fue 5,059,448,832 bytes disponibles y swap
  activa de 4,294,963,200 bytes con `vm.swappiness=10`.
- La revisión manual autenticada con `playwright-cli` obtuvo HTTP 200 en Auth y
  dashboard, cero errores/advertencias de consola y navegación móvil a 390x844.
- Cierre de sesión y recuperación de contraseña están implementados. Staging
  entrega los enlaces en Mailpit, aislado en la red Docker y sin puerto público;
  producción debe sustituirlo por el SMTP corporativo.
  El flujo live validó correo, token de recuperación, contraseña nueva, nuevo
  login y cierre global; el mensaje de prueba se eliminó al finalizar.

## Comandos de verificación

```bash
docker compose ps -a
curl -fsS http://127.0.0.1:3089/api/health
curl -fsS http://127.0.0.1:3089/api/v1/health
free -b
swapon --show --bytes
```

TLS permanece pendiente hasta que `d89.escalaleads.com.mx` tenga un registro
DNS apuntando al VPS. Nginx ya publica HTTP por `Host` hacia loopback 3089.
