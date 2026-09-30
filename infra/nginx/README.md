# Nginx del host — d89.escalaleads.com.mx

Nginx es la única entrada pública del VPS y reenvía todo a Caddy en `127.0.0.1:3089`.
Los archivos de este directorio son la fuente de verdad: no se editan a mano en
`/etc/nginx` ni se usa `certbot --nginx`, que reescribiría el archivo instalado.

| Archivo | Cuándo se usa |
|---|---|
| `d89.escalaleads.com.mx.http.conf` | Etapa 1: HTTP hacia Caddy + reto ACME. No requiere certificado. |
| `d89.escalaleads.com.mx.conf` | Etapa 2 (final): HTTPS con HTTP/2 y HSTS; HTTP sólo redirige y atiende renovaciones. |

## Habilitar HTTPS

1. Crea el registro DNS `A` de `d89.escalaleads.com.mx` hacia la IP pública del VPS
   (`187.124.81.158`). No crees un `AAAA` salvo que apunte a la IPv6 de este servidor:
   Let's Encrypt también valida por IPv6.
2. Verifica sin cambiar nada:
   ```bash
   sudo infra/scripts/enable-d89-tls.sh
   ```
   Sale con código 0 cuando el DNS ya apunta a este servidor (2 si todavía no).
3. Aplica:
   ```bash
   sudo infra/scripts/enable-d89-tls.sh --apply
   ```
   El script:
   - respalda el sitio actual (`*.bak-FECHA`);
   - instala la etapa 1;
   - comprueba el reto ACME desde el dominio público;
   - emite el certificado con `certbot certonly --webroot`, reutilizando la cuenta ACME del
     servidor;
   - instala la etapa 2 y verifica que HTTP → 301 y que `https://…/api/health` → 200.

   Cada cambio pasa por `nginx -t`. Ante cualquier falla, restaura el respaldo y recarga
   Nginx. Es idempotente: si el certificado ya existe, sólo reinstala la etapa 2.
4. Retira el túnel temporal cuando confirmes el acceso:
   `sudo systemctl disable --now d89-ngrok.service`.

## Renovación

`certbot.timer` renueva automáticamente con el mismo webroot (`/var/www/letsencrypt`)
y el hook `systemctl reload nginx` queda guardado en
`/etc/letsencrypt/renewal/d89.escalaleads.com.mx.conf`. Prueba en seco:
`sudo certbot renew --dry-run --cert-name d89.escalaleads.com.mx`.

## Notas

- Nginx 1.24 (Ubuntu 24.04): se usa `listen 443 ssl http2`; la directiva `http2 on`
  no existe hasta 1.25.1.
- HSTS sin `includeSubDomains` ni `preload`: `escalaleads.com.mx` tiene otros
  subdominios que no se gestionan aquí.
- `client_max_body_size 12m`: la API limita CSF, tickets y NEODATA a 10 MB. El margen
  cubre el multipart, para que el límite y su mensaje los dé la API y no Nginx.
- Compose ya publica Auth, Storage, CORS y el web con `https://${PUBLIC_DOMAIN}`, así
  que el cambio no requiere tocar Compose ni Caddy.
