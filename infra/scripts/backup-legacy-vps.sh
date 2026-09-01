#!/usr/bin/env bash
set -Eeuo pipefail

backup_root="${1:-/var/backups/d89-preparation}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${backup_root}/${timestamp}"

umask 077
install -d -m 0700 "${backup_root}" "${backup_dir}" \
  "${backup_dir}/dumps" "${backup_dir}/inventory" "${backup_dir}/volumes"

docker ps -a --no-trunc >"${backup_dir}/inventory/docker-containers.txt"
docker image ls --digests --no-trunc >"${backup_dir}/inventory/docker-images.txt"
docker volume ls >"${backup_dir}/inventory/docker-volumes.txt"
docker network ls >"${backup_dir}/inventory/docker-networks.txt"
docker inspect $(docker ps -aq) >"${backup_dir}/inventory/docker-inspect.json"
systemctl list-unit-files --type=service --no-pager >"${backup_dir}/inventory/system-services.txt"
systemctl --user list-unit-files --type=service --no-pager >"${backup_dir}/inventory/user-services.txt"
ss -tulpen >"${backup_dir}/inventory/listening-ports.txt"
nginx -T >"${backup_dir}/inventory/nginx-expanded.txt" 2>&1

docker exec backend-postgres-1 pg_dumpall -U postgres --clean --if-exists \
  >"${backup_dir}/dumps/backend-postgres.sql"
docker exec insforge-main-postgres-1 pg_dumpall -U postgres --clean --if-exists \
  >"${backup_dir}/dumps/insforge-main-postgres.sql"

funeraria_was_running="$(docker inspect -f '{{.State.Running}}' funeraria-app-db-1)"
if [[ "${funeraria_was_running}" != "true" ]]; then
  docker start funeraria-app-db-1 >/dev/null
  for _ in $(seq 1 30); do
    if docker exec funeraria-app-db-1 pg_isready -U postgres >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi
docker exec funeraria-app-db-1 sh -lc 'pg_dumpall -U "$POSTGRES_USER" --clean --if-exists' \
  >"${backup_dir}/dumps/funeraria-postgres.sql"
if [[ "${funeraria_was_running}" != "true" ]]; then
  docker stop funeraria-app-db-1 >/dev/null
fi

tar --ignore-failed-read -czf "${backup_dir}/protected-configs.tar.gz" \
  /root/appinmobilaria/backend/docker-compose.yml \
  /root/appinmobilaria/backend/.env* \
  /root/insforge/docker-compose*.yml \
  /root/insforge/.env* \
  /root/vibevoice/docker-compose.yml \
  /root/vibevoice/.env* \
  /root/vibevoice/tts/config \
  /root/funeraria-app/docker-compose.yml \
  /root/funeraria-app/.env* \
  /root/.config/systemd/user \
  /etc/nginx \
  /etc/letsencrypt \
  /etc/fstab \
  /etc/sysctl.conf \
  /etc/sysctl.d 2>"${backup_dir}/inventory/config-archive-warnings.txt"

for volume in \
  backend_deno_cache backend_insforge-logs backend_postgres-data backend_storage-data \
  insforge-main_deno_cache insforge-main_postgres-data insforge-main_shared-logs insforge-main_storage-data \
  funeraria-app_postgres_data; do
  if docker volume inspect "${volume}" >/dev/null 2>&1; then
    if ! docker run --rm --network none \
      -v "${volume}:/source:ro" \
      -v "${backup_dir}/volumes:/backup" \
      alpine:latest tar -C /source -czf "/backup/${volume}.tar.gz" .; then
      printf 'Volume snapshot reported an error: %s\n' "${volume}" \
        >>"${backup_dir}/inventory/volume-archive-warnings.txt"
    fi
  fi
done

cat >"${backup_dir}/RESTORE.md" <<'EOF'
# Restauración del VPS anterior a D89

Este respaldo contiene secretos. Mantener el directorio y todos sus archivos fuera de Git y con acceso restringido.

## Configuración

```bash
tar -xzf protected-configs.tar.gz -C /
systemctl daemon-reload
systemctl --user daemon-reload
nginx -t && systemctl reload nginx
```

## Volúmenes Docker

Para cada archivo de `volumes/`:

```bash
docker volume create NOMBRE_DEL_VOLUMEN
docker run --rm --network none -v NOMBRE_DEL_VOLUMEN:/target -v "$PWD/volumes:/backup:ro" alpine:latest sh -c 'tar -C /target -xzf /backup/NOMBRE_DEL_VOLUMEN.tar.gz'
```

## Bases PostgreSQL

Levantar primero el contenedor correspondiente y restaurar el dump lógico:

```bash
docker exec -i backend-postgres-1 psql -U postgres < dumps/backend-postgres.sql
docker exec -i insforge-main-postgres-1 psql -U postgres < dumps/insforge-main-postgres.sql
docker exec -i funeraria-app-db-1 sh -lc 'psql -U "$POSTGRES_USER"' < dumps/funeraria-postgres.sql
```

## Servicios anteriores

```bash
docker start backend-insforge-1 backend-postgrest-1 backend-deno-1 backend-postgres-1
docker start insforge-main-insforge-1 insforge-main-deno-1 insforge-main-postgrest-1 insforge-main-postgres-1
docker start vibevoice-asr vibevoice-tts drawdb openclaw-gw-bridge
systemctl --user enable --now hermes-gateway.service insforge-ngrok.service openclaw-gateway.service
```
EOF

find "${backup_dir}" -type f -exec chmod 0600 {} +
find "${backup_dir}" -type d -exec chmod 0700 {} +
sha256sum "${backup_dir}"/dumps/*.sql "${backup_dir}"/protected-configs.tar.gz \
  "${backup_dir}"/volumes/*.tar.gz >"${backup_dir}/SHA256SUMS"

printf '%s\n' "${backup_dir}"
