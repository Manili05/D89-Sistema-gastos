#!/usr/bin/env bash
set -Eeuo pipefail

for command in docker age aws sha256sum; do
  command -v "${command}" >/dev/null || { printf 'Falta comando: %s\n' "${command}" >&2; exit 1; }
done
: "${B2_BUCKET:?set B2_BUCKET}"
: "${B2_ENDPOINT:?set B2_ENDPOINT}"
: "${BACKUP_AGE_IDENTITY_FILE:?set BACKUP_AGE_IDENTITY_FILE}"

temp_dir="$(mktemp -d /tmp/d89-restore-check.XXXXXX)"
container_name="d89-restore-check-$(date -u +%s)"
cleanup() {
  docker rm -f "${container_name}" >/dev/null 2>&1 || true
  rm -rf -- "${temp_dir}"
}
trap cleanup EXIT
umask 077

latest_key="$(AWS_ACCESS_KEY_ID="${B2_KEY_ID}" AWS_SECRET_ACCESS_KEY="${B2_APPLICATION_KEY}" \
  aws s3api list-objects-v2 --bucket "${B2_BUCKET}" --prefix daily/ \
  --endpoint-url "${B2_ENDPOINT}" --query 'sort_by(Contents,&LastModified)[-1].Key' \
  --output text)"
test -n "${latest_key}" && test "${latest_key}" != "None"
AWS_ACCESS_KEY_ID="${B2_KEY_ID}" AWS_SECRET_ACCESS_KEY="${B2_APPLICATION_KEY}" \
  aws s3 cp "s3://${B2_BUCKET}/${latest_key}" "${temp_dir}/backup.age" \
  --endpoint-url "${B2_ENDPOINT}"
age -d -i "${BACKUP_AGE_IDENTITY_FILE}" "${temp_dir}/backup.age" \
  | tar -C "${temp_dir}" -xzf -
(cd "${temp_dir}" && sha256sum -c SHA256SUMS)

docker run -d --name "${container_name}" --network none \
  -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17.6-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "${container_name}" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "${container_name}" createdb -U postgres restorecheck
docker exec -i "${container_name}" pg_restore -U postgres -d restorecheck \
  --clean --if-exists <"${temp_dir}/database.dump"
docker exec "${container_name}" psql -U postgres -d restorecheck -v ON_ERROR_STOP=1 \
  -c "select count(*) from public.perfil_usuario" >/dev/null
tar -tzf "${temp_dir}/comprobantes.tar.gz" >/dev/null
printf 'Restauración verificada: %s\n' "${latest_key}"
