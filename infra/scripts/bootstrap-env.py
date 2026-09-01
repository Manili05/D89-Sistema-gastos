import argparse
import os
import secrets
import time
from pathlib import Path

import jwt

ROOT = Path(__file__).resolve().parents[2]
TARGET = ROOT / ".env"


def token(size: int = 32) -> str:
    return secrets.token_urlsafe(size)


def main() -> None:
    parser = argparse.ArgumentParser(description="Genera secretos locales de staging D89")
    parser.add_argument(
        "--rotate",
        action="store_true",
        help="reemplaza atómicamente un .env existente con secretos nuevos",
    )
    args = parser.parse_args()
    if TARGET.exists() and not args.rotate:
        raise SystemExit(".env ya existe; no se sobrescribió")
    jwt_secret = token(48)
    now = int(time.time())
    common = {"iss": "supabase-d89", "iat": now, "exp": now + 10 * 365 * 86400}
    anon_key = jwt.encode({**common, "role": "anon"}, jwt_secret, algorithm="HS256")
    service_key = jwt.encode({**common, "role": "service_role"}, jwt_secret, algorithm="HS256")
    postgres_password = token(32)
    values = {
        "APP_ENV": "staging",
        "APP_TIMEZONE": "America/Mexico_City",
        "APP_CURRENCY": "MXN",
        "PUBLIC_DOMAIN": "d89.escalaleads.com.mx",
        "NEXT_PUBLIC_API_URL": "/api/v1",
        "NEXT_PUBLIC_SUPABASE_URL": "https://d89.escalaleads.com.mx",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY": anon_key,
        "POSTGRES_DB": "d89",
        "POSTGRES_USER": "postgres",
        "POSTGRES_PASSWORD": postgres_password,
        "DATABASE_URL": f"postgresql://postgres:{postgres_password}@postgres:5432/d89",
        "JWT_SECRET": jwt_secret,
        "ANON_KEY": anon_key,
        "SERVICE_ROLE_KEY": service_key,
        "HERMES_HMAC_KEY_ID": "hermes-staging",
        "HERMES_HMAC_SECRET": token(48),
        "HERMES_API_SERVER_KEY": token(40),
        "HERMES_SANDBOX_MODE": "true",
        "WHATSAPP_VERIFY_TOKEN": "replace-after-meta-approval",
        "WHATSAPP_ACCESS_TOKEN": "replace-after-meta-approval",
        "WHATSAPP_PHONE_NUMBER_ID": "replace-after-meta-approval",
        "MOONSHOT_API_KEY": "replace-with-kimi-api-key",
        "LITELLM_MASTER_KEY": f"sk-{token(32)}",
        "LITELLM_SALT_KEY": token(48),
        "LITELLM_MONTHLY_BUDGET_MXN": "1000",
        "LITELLM_MXN_PER_USD": "replace-with-approved-accounting-rate",
        "LITELLM_RATE_DATE": "YYYY-MM-DD",
        "LITELLM_D89_API_KEY": "provision-with-infra-script",
        "B2_BUCKET": "d89-backups",
        "B2_ENDPOINT": "replace-with-b2-s3-endpoint",
        "B2_KEY_ID": "replace-with-b2-key-id",
        "B2_APPLICATION_KEY": "replace-with-b2-application-key",
        "BACKUP_AGE_RECIPIENT": "replace-with-age-public-recipient",
        "BACKUP_AGE_IDENTITY_FILE": "/root/.config/d89/backup-age-key.txt",
        "BACKUP_RETENTION_DAYS": "14",
        "STAGING_ADMIN_EMAIL": "admin@d89.local",
        "STAGING_ADMIN_PASSWORD": token(24),
    }
    output = TARGET.with_suffix(".env.rotating") if args.rotate else TARGET
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
        stream.writelines(f"{key}={value}\n" for key, value in values.items())
    if args.rotate:
        os.replace(output, TARGET)
        TARGET.chmod(0o600)
    print(f"Entorno staging creado con modo 0600: {TARGET}")


if __name__ == "__main__":
    main()
