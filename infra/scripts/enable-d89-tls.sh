#!/usr/bin/env bash
# Habilita HTTPS para D89 en el Nginx del host con Let's Encrypt (certbot --webroot).
#
#   sudo infra/scripts/enable-d89-tls.sh            # sólo verifica, no cambia nada
#   sudo infra/scripts/enable-d89-tls.sh --apply    # aplica (requiere DNS listo)
#   sudo infra/scripts/enable-d89-tls.sh --apply --email ops@example.com
#
# Etapas: 1) instala la config HTTP con reto ACME, 2) emite el certificado,
# 3) instala la config HTTPS del repo. Cada cambio en /etc/nginx pasa por
# `nginx -t`; si algo falla se restaura el respaldo y se recarga Nginx.
# Idempotente: si el certificado ya existe, salta directo a la etapa 3.
set -Eeuo pipefail
IFS=$'\n\t'

readonly DOMAIN="d89.escalaleads.com.mx"
readonly WEBROOT="/var/www/letsencrypt"
readonly SITE_AVAILABLE="/etc/nginx/sites-available/${DOMAIN}"
readonly SITE_ENABLED="/etc/nginx/sites-enabled/${DOMAIN}"
readonly CERT_DIR="/etc/letsencrypt/live/${DOMAIN}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
readonly REPO_NGINX="${SCRIPT_DIR}/../nginx"
readonly HTTP_CONF="${REPO_NGINX}/${DOMAIN}.http.conf"
readonly TLS_CONF="${REPO_NGINX}/${DOMAIN}.conf"

APPLY=false
EMAIL=""
BACKUP=""
CHANGED=false
TMP_DIR=""

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,7p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

cleanup() {
  local status=$?
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then rm -rf -- "${TMP_DIR}"; fi
  if [[ ${status} -ne 0 && "${CHANGED}" == true ]]; then
    log "Falla detectada: restaurando la configuración anterior de Nginx"
    if [[ -n "${BACKUP}" && -f "${BACKUP}" ]]; then
      cp -p -- "${BACKUP}" "${SITE_AVAILABLE}"
    fi
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx && log "Nginx restaurado y recargado (${BACKUP:-sin respaldo})"
    else
      log "ATENCIÓN: nginx -t sigue fallando tras restaurar; revisa ${SITE_AVAILABLE}"
    fi
  fi
  exit "${status}"
}
trap cleanup EXIT

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --apply) APPLY=true ;;
      --email) [[ $# -ge 2 ]] || die "--email requiere un valor"; EMAIL="$2"; shift ;;
      -h|--help) usage 0 ;;
      *) printf 'Opción desconocida: %s\n' "$1" >&2; usage 1 ;;
    esac
    shift
  done
}

require_tools() {
  local tool
  for tool in nginx certbot curl getent systemctl ip; do
    command -v "${tool}" >/dev/null 2>&1 || die "Falta la herramienta requerida: ${tool}"
  done
  [[ -f "${HTTP_CONF}" && -f "${TLS_CONF}" ]] || die "No encuentro las configs en ${REPO_NGINX}"
}

# Test a candidate site file in isolation (never touches /etc/nginx).
test_candidate() {
  local candidate="$1"
  TMP_DIR="${TMP_DIR:-$(mktemp -d)}"
  cat > "${TMP_DIR}/nginx.conf" <<EOF
pid ${TMP_DIR}/nginx.pid;
error_log ${TMP_DIR}/error.log;
events {}
http {
  include /etc/nginx/mime.types;
  access_log off;
  include ${candidate};
}
EOF
  nginx -t -q -c "${TMP_DIR}/nginx.conf" -p "${TMP_DIR}"
}

server_ips() {
  ip -o addr show scope global | awk '{split($4, a, "/"); print a[1]}' | sort -u
}

check_dns() {
  local resolved ours address missing=false
  ours="$(server_ips)"
  resolved="$(getent ahosts "${DOMAIN}" | awk '{print $1}' | sort -u || true)"
  if [[ -z "${resolved}" ]]; then
    log "DNS: ${DOMAIN} todavía no resuelve. Crea un registro A hacia $(server_ips | grep -v ':' | grep -v '^172\.' | head -n1)."
    return 1
  fi
  while IFS= read -r address; do
    [[ -z "${address}" ]] && continue
    if grep -qxF -- "${address}" <<<"${ours}"; then
      log "DNS: ${address} apunta a este servidor"
    else
      # Let's Encrypt valida también por AAAA: una IPv6 ajena hace fallar la emisión.
      log "DNS: ${address} NO pertenece a este servidor"
      missing=true
    fi
  done <<<"${resolved}"
  [[ "${missing}" == false ]]
}

check_acme_path() {
  local token="d89-preflight-$$-${RANDOM}" body
  # Explicit modes: Nginx workers run as www-data regardless of the caller's umask.
  install -d -m 0755 -- "${WEBROOT}" "${WEBROOT}/.well-known" "${WEBROOT}/.well-known/acme-challenge"
  printf '%s' "${token}" > "${WEBROOT}/.well-known/acme-challenge/${token}"
  chmod 0644 -- "${WEBROOT}/.well-known/acme-challenge/${token}"
  body="$(curl -fsS --max-time 15 "http://${DOMAIN}/.well-known/acme-challenge/${token}" || true)"
  rm -f -- "${WEBROOT}/.well-known/acme-challenge/${token}"
  [[ "${body}" == "${token}" ]] || die "El reto ACME no es accesible por http://${DOMAIN}; revisa DNS y el puerto 80"
  log "Reto ACME accesible desde http://${DOMAIN}"
}

install_site() {
  local source="$1"
  if [[ -z "${BACKUP}" && -f "${SITE_AVAILABLE}" ]]; then
    BACKUP="${SITE_AVAILABLE}.bak-$(date +%Y%m%d%H%M%S)"
    cp -p -- "${SITE_AVAILABLE}" "${BACKUP}"
    log "Respaldo: ${BACKUP}"
  fi
  CHANGED=true
  install -m 0644 -- "${source}" "${SITE_AVAILABLE}"
  ln -sfn -- "${SITE_AVAILABLE}" "${SITE_ENABLED}"
  nginx -t -q || die "nginx -t rechazó $(basename -- "${source}")"
  systemctl reload nginx
  log "Instalada $(basename -- "${source}") y Nginx recargado"
}

issue_certificate() {
  local account=(--register-unsafely-without-email)
  if [[ -n "${EMAIL}" ]]; then
    account=(--email "${EMAIL}")
  elif compgen -G "/etc/letsencrypt/accounts/*/directory/*" >/dev/null; then
    account=()  # Reuse the existing ACME account on this host.
  fi
  certbot certonly --webroot -w "${WEBROOT}" -d "${DOMAIN}" \
    --non-interactive --agree-tos --keep-until-expiring \
    --deploy-hook "systemctl reload nginx" "${account[@]}"
  [[ -s "${CERT_DIR}/fullchain.pem" ]] || die "certbot no dejó el certificado en ${CERT_DIR}"
  log "Certificado emitido para ${DOMAIN}"
}

verify_public() {
  local redirect health
  redirect="$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 15 "http://${DOMAIN}/" || true)"
  health="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/api/health" || true)"
  log "HTTP  → ${redirect}"
  log "HTTPS → /api/health ${health}"
  [[ "${redirect}" == "301 https://${DOMAIN}/" && "${health}" == "200" ]] \
    || die "La verificación pública no pasó"
}

main() {
  parse_args "$@"
  [[ ${EUID} -eq 0 ]] || die "Ejecuta como root (sudo)"
  require_tools

  log "Verificando sintaxis de las configs del repo"
  test_candidate "${HTTP_CONF}"
  log "OK ${HTTP_CONF##*/}"
  if [[ -s "${CERT_DIR}/fullchain.pem" ]]; then
    test_candidate "${TLS_CONF}"
    log "OK ${TLS_CONF##*/} (certificado existente)"
  else
    log "Aún no hay certificado; ${TLS_CONF##*/} se validará después de emitirlo"
  fi

  local dns_ready=true
  check_dns || dns_ready=false

  if [[ "${APPLY}" != true ]]; then
    log "Modo verificación: no se cambió nada. Usa --apply para habilitar HTTPS."
    [[ "${dns_ready}" == true ]] || exit 2
    exit 0
  fi
  [[ "${dns_ready}" == true ]] || die "El DNS no está listo; no se aplicó ningún cambio"

  if [[ ! -s "${CERT_DIR}/fullchain.pem" ]]; then
    install_site "${HTTP_CONF}"
    check_acme_path
    issue_certificate
  fi
  install_site "${TLS_CONF}"
  verify_public
  CHANGED=false
  log "HTTPS activo en https://${DOMAIN}. Renovación: certbot.timer (webroot + reload)."
  log "Cuando lo confirmes, retira el túnel temporal: systemctl disable --now d89-ngrok.service"
}

main "$@"
