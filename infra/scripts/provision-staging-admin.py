import argparse
import json
import os
import secrets
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if raw_line and not raw_line.startswith("#") and "=" in raw_line:
            key, value = raw_line.split("=", 1)
            values[key] = value
    return values


def replace_env_value(key: str, value: str) -> None:
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    output: list[str] = []
    replaced = False
    for line in lines:
        if line.startswith(f"{key}="):
            output.append(f"{key}={value}")
            replaced = True
        else:
            output.append(line)
    if not replaced:
        output.append(f"{key}={value}")
    descriptor, temporary = tempfile.mkstemp(prefix=".env.", dir=ROOT, text=True)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write("\n".join(output) + "\n")
        os.replace(temporary, ENV_FILE)
        ENV_FILE.chmod(0o600)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def request_json(
    url: str,
    method: str,
    key: str,
    payload: dict[str, object] | None = None,
    prefer: str | None = None,
) -> object:
    headers = {
        "Authorization": f"Bearer {key}",
        "apikey": key,
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    request = urllib.request.Request(
        url,
        method=method,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers=headers,
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        content = response.read()
        return json.loads(content) if content else {}


def main() -> None:
    parser = argparse.ArgumentParser(description="Provisiona el administrador staging")
    parser.add_argument(
        "--rotate-password",
        action="store_true",
        help="rota la contraseña en Auth y .env sin mostrarla",
    )
    args = parser.parse_args()
    env = load_env()
    base_url = os.environ.get("D89_BASE_URL", "http://127.0.0.1:3089")
    email = env["STAGING_ADMIN_EMAIL"]
    service_key = env["SERVICE_ROLE_KEY"]
    try:
        user = request_json(
            f"{base_url}/auth/v1/admin/users",
            "POST",
            service_key,
            {
                "email": email,
                "password": env["STAGING_ADMIN_PASSWORD"],
                "email_confirm": True,
                "app_metadata": {"role": "admin"},
                "user_metadata": {"name": "Administrador D89"},
            },
        )
    except urllib.error.HTTPError as exc:
        if exc.code != 422:
            detail = exc.read().decode(errors="replace")
            raise SystemExit(
                f"No fue posible crear el usuario Auth: HTTP {exc.code}: {detail}"
            ) from exc
        listing = request_json(
            f"{base_url}/auth/v1/admin/users?page=1&per_page=100",
            "GET",
            service_key,
        )
        candidates = listing.get("users", []) if isinstance(listing, dict) else []
        user = next((item for item in candidates if item.get("email") == email), None)
        if user is None:
            raise SystemExit("Auth reportó usuario duplicado pero no fue posible localizarlo")
    if not isinstance(user, dict):
        raise SystemExit("Auth devolvió una respuesta inesperada")
    user_id = user.get("id")
    if not user_id:
        raise SystemExit("Auth no devolvió el ID del administrador")
    if args.rotate_password:
        new_password = secrets.token_urlsafe(32)
        request_json(
            f"{base_url}/auth/v1/admin/users/{user_id}",
            "PUT",
            service_key,
            {"password": new_password, "app_metadata": {"role": "admin"}},
        )
        replace_env_value("STAGING_ADMIN_PASSWORD", new_password)
    request_json(
        f"{base_url}/rest/v1/perfil_usuario",
        "POST",
        service_key,
        {
            "id": user_id,
            "nombre": "Administrador D89",
            "rol": "admin",
            "activo": True,
        },
        "resolution=merge-duplicates",
    )
    works = request_json(
        f"{base_url}/rest/v1/obra?nombre=eq.Infra%20Toluca&select=id",
        "GET",
        service_key,
    )
    if not isinstance(works, list):
        raise SystemExit("PostgREST devolvió una respuesta inesperada al consultar obras")
    if works:
        work_id = works[0]["id"]
    else:
        created = request_json(
            f"{base_url}/rest/v1/obra",
            "POST",
            service_key,
            {
                "nombre": "Infra Toluca",
                "ubicacion": "Toluca, Estado de México",
                "responsable_id": user_id,
            },
            "return=representation",
        )
        if not isinstance(created, list) or not created:
            raise SystemExit("No fue posible crear la obra inicial")
        work_id = created[0]["id"]
    request_json(
        f"{base_url}/rest/v1/usuario_obra",
        "POST",
        service_key,
        {"usuario_id": user_id, "obra_id": work_id},
        "resolution=merge-duplicates",
    )
    print(f"Administrador staging provisionado: {email} ({user_id})")
    if args.rotate_password:
        print("Contraseña staging rotada en Auth y .env sin exponer su valor")
    print(f"Obra inicial provisionada: Infra Toluca ({work_id})")


if __name__ == "__main__":
    main()
