#!/usr/bin/env python3
"""Exercise the real password-recovery and logout flow without logging secrets."""

from __future__ import annotations

import html
import json
import os
import re
import secrets
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import parse_qs, urlsplit, urlunsplit

import httpx

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"
BASE_URL = "http://127.0.0.1:3089"


def load_env() -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    )


def replace_env_value(key: str, value: str) -> None:
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    output = [f"{key}={value}" if line.startswith(f"{key}=") else line for line in lines]
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


def mailpit_request(path: str, method: str = "GET") -> dict[str, object]:
    script = f"""
import urllib.request
request = urllib.request.Request('http://mailpit:8025{path}', method='{method}')
with urllib.request.urlopen(request, timeout=15) as response:
    print(response.read().decode() or '{{}}')
"""
    completed = subprocess.run(
        ["docker", "compose", "exec", "-T", "api", "python", "-"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        input=script,
    )
    if method == "DELETE" or not completed.stdout.strip():
        return {}
    return json.loads(completed.stdout)


def recovery_link(email: str) -> str:
    listing = mailpit_request("/api/v1/messages")
    messages = listing.get("messages", [])
    if not isinstance(messages, list):
        raise SystemExit("Mailpit devolvió una bandeja inesperada")
    message_id = next(
        (
            item.get("ID")
            for item in messages
            if email in json.dumps(item, ensure_ascii=False)
        ),
        None,
    )
    if not message_id:
        raise SystemExit("No se recibió el correo de recuperación en Mailpit")
    message = mailpit_request(f"/api/v1/message/{message_id}")
    content = html.unescape(str(message.get("HTML", "")) + str(message.get("Text", "")))
    links = re.findall(r"https?://[^\s\"'<>]+", content)
    link = next((candidate for candidate in links if "type=recovery" in candidate), None)
    if not link:
        raise SystemExit("El correo no contiene un enlace de recuperación")
    return link


def localize_auth_link(link: str) -> str:
    parsed = urlsplit(link)
    return urlunsplit(("http", "127.0.0.1:3089", parsed.path, parsed.query, parsed.fragment))


def main() -> None:
    env = load_env()
    headers = {"apikey": env["ANON_KEY"]}
    email = env["STAGING_ADMIN_EMAIL"]
    with httpx.Client(base_url=BASE_URL, timeout=30) as client:
        recovery = client.post(
            "/auth/v1/recover",
            headers=headers,
            json={
                "email": email,
                "gotrue_meta_security": {},
                "redirect_to": f"{BASE_URL}/restablecer-contrasena",
            },
        )
        recovery.raise_for_status()
        verify = client.get(localize_auth_link(recovery_link(email)), follow_redirects=False)
        if verify.status_code not in (302, 303):
            raise SystemExit("GoTrue no aceptó el enlace de recuperación")
        location = verify.headers.get("location", "")
        redirect = urlsplit(location)
        tokens = {**parse_qs(redirect.query), **parse_qs(redirect.fragment)}
        access_token = tokens.get("access_token", [""])[0]
        if not access_token:
            raise SystemExit("GoTrue no creó una sesión de recuperación")

        new_password = secrets.token_urlsafe(32)
        authenticated = {**headers, "Authorization": f"Bearer {access_token}"}
        update = client.put(
            "/auth/v1/user", headers=authenticated, json={"password": new_password}
        )
        update.raise_for_status()
        login = client.post(
            "/auth/v1/token?grant_type=password",
            headers=headers,
            json={"email": email, "password": new_password},
        )
        login.raise_for_status()
        replace_env_value("STAGING_ADMIN_PASSWORD", new_password)
        logout = client.post(
            "/auth/v1/logout?scope=global",
            headers={**headers, "Authorization": f"Bearer {login.json()['access_token']}"},
        )
        logout.raise_for_status()

    mailpit_request("/api/v1/messages", method="DELETE")
    print("Recuperación, contraseña nueva, login y cierre de sesión live aprobados")


if __name__ == "__main__":
    main()
