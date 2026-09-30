#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir="${1:?usage: infra-vps-transition.sh BACKUP_DIR}"
workspace="/var/www/Apparquitectos/d89-sistema-gastos"

test -s "${backup_dir}/SHA256SUMS"
(cd "${backup_dir}" && sha256sum -c SHA256SUMS >/dev/null)

docker stop \
  backend-insforge-1 backend-postgrest-1 backend-deno-1 backend-postgres-1 \
  insforge-main-insforge-1 insforge-main-deno-1 insforge-main-postgrest-1 insforge-main-postgres-1 \
  vibevoice-asr vibevoice-tts drawdb openclaw-gw-bridge >/dev/null

systemctl --user disable --now \
  hermes-gateway.service insforge-ngrok.service openclaw-gateway.service

while read -r pid; do
  [[ -n "${pid}" ]] && kill "${pid}"
done < <(pgrep -f '^/root/.nvm/versions/node/.*/node /root/appinmobilaria/node_modules/astro/bin/astro.mjs dev ' || true)

while read -r pid; do
  [[ -n "${pid}" ]] && kill "${pid}"
done < <(pgrep -f '^/usr/local/lib/hermes-agent/venv/bin/python3? /usr/local/lib/hermes-agent/venv/bin/hermes dashboard ' || true)

install -d -m 0755 /etc/nginx/sites-disabled
if [[ -L /etc/nginx/sites-enabled/appinmobilaria-review ]]; then
  mv /etc/nginx/sites-enabled/appinmobilaria-review \
    /etc/nginx/sites-disabled/appinmobilaria-review
fi
nginx -t
systemctl reload nginx

if ! swapon --show=NAME --noheadings | grep -Fxq '/swapfile'; then
  if [[ ! -e /swapfile ]]; then
    fallocate -l 4G /swapfile
  fi
  chmod 0600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
fi

if ! grep -Eq '^[[:space:]]*/swapfile[[:space:]]+none[[:space:]]+swap([[:space:]]|$)' /etc/fstab; then
  printf '\n/swapfile none swap sw 0 0\n' >>/etc/fstab
fi

printf 'vm.swappiness=10\n' >/etc/sysctl.d/99-d89-memory.conf
chmod 0644 /etc/sysctl.d/99-d89-memory.conf
sysctl -p /etc/sysctl.d/99-d89-memory.conf >/dev/null

install -m 0600 "${workspace}/infra-restore-disabled-services.md" \
  "${backup_dir}/RESTORE_DISABLED_SERVICES.md"

sync
