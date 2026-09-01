#!/usr/bin/env bash
set -Eeuo pipefail

for command in docker age aws sha256sum; do
  command -v "${command}" >/dev/null || { printf 'Falta comando: %s\n' "${command}" >&2; exit 1; }
done
: "${B2_BUCKET:?set B2_BUCKET}"
: "${B2_ENDPOINT:?set B2_ENDPOINT}"
: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT}"

retention_days="${BACKUP_RETENTION_DAYS:-14}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
temp_dir="$(mktemp -d /tmp/d89-backup.XXXXXX)"
trap 'rm -rf -- "${temp_dir}"' EXIT
umask 077

docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-postgres}" \
  --format=custom --clean --if-exists "${POSTGRES_DB:-d89}" >"${temp_dir}/database.dump"
docker run --rm --network none -v d89_storage-data:/source:ro -v "${temp_dir}:/backup" \
  alpine:latest tar -C /source -czf /backup/comprobantes.tar.gz .
sha256sum "${temp_dir}/database.dump" "${temp_dir}/comprobantes.tar.gz" \
  >"${temp_dir}/SHA256SUMS"
tar -C "${temp_dir}" -czf - database.dump comprobantes.tar.gz SHA256SUMS \
  | age -r "${BACKUP_AGE_RECIPIENT}" -o "${temp_dir}/d89-${timestamp}.tar.gz.age"

AWS_ACCESS_KEY_ID="${B2_KEY_ID}" AWS_SECRET_ACCESS_KEY="${B2_APPLICATION_KEY}" \
  aws s3 cp "${temp_dir}/d89-${timestamp}.tar.gz.age" \
  "s3://${B2_BUCKET}/daily/d89-${timestamp}.tar.gz.age" --endpoint-url "${B2_ENDPOINT}"

cutoff="$(date -u -d "-${retention_days} days" +%Y%m%dT%H%M%SZ)"
AWS_ACCESS_KEY_ID="${B2_KEY_ID}" AWS_SECRET_ACCESS_KEY="${B2_APPLICATION_KEY}" \
  aws s3api list-objects-v2 --bucket "${B2_BUCKET}" --prefix daily/ \
  --endpoint-url "${B2_ENDPOINT}" --query 'Contents[].Key' --output text \
  | tr '\t' '\n' | while read -r key; do
      stamp="${key#daily/d89-}"; stamp="${stamp%.tar.gz.age}"
      if [[ "${stamp}" < "${cutoff}" ]]; then
        AWS_ACCESS_KEY_ID="${B2_KEY_ID}" AWS_SECRET_ACCESS_KEY="${B2_APPLICATION_KEY}" \
          aws s3 rm "s3://${B2_BUCKET}/${key}" --endpoint-url "${B2_ENDPOINT}"
      fi
    done
