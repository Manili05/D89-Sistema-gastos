#!/usr/bin/env python3
"""Provision the budgeted LiteLLM key used by Hermes without logging secrets."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_DOWN
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env"
PLACEHOLDERS = ("replace-", "provision-")


def load_env() -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    )


def require_value(values: dict[str, str], key: str) -> str:
    value = values.get(key, "").strip()
    if not value or value.startswith(PLACEHOLDERS):
        raise SystemExit(f"Configura {key} antes de provisionar LiteLLM")
    return value


def usd_budget(values: dict[str, str]) -> Decimal:
    try:
        mxn = Decimal(require_value(values, "LITELLM_MONTHLY_BUDGET_MXN"))
        rate = Decimal(require_value(values, "LITELLM_MXN_PER_USD"))
    except InvalidOperation as error:
        raise SystemExit("El presupuesto y el tipo de cambio deben ser numéricos") from error
    if mxn <= 0 or rate <= 0:
        raise SystemExit("El presupuesto y el tipo de cambio deben ser positivos")
    try:
        date.fromisoformat(require_value(values, "LITELLM_RATE_DATE"))
    except ValueError as error:
        raise SystemExit("LITELLM_RATE_DATE debe usar el formato YYYY-MM-DD") from error
    # Round down so the configured ceiling cannot exceed the approved MXN amount.
    return (mxn / rate).quantize(Decimal("0.000001"), rounding=ROUND_DOWN)


def run_compose(*arguments: str, input_text: str | None = None) -> str:
    completed = subprocess.run(
        ["docker", "compose", *arguments],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        input=input_text,
    )
    return completed.stdout


def call_proxy(script: str, *, virtual_key: str | None = None) -> dict[str, object]:
    command = ["exec", "-T"]
    process_env = os.environ.copy()
    if virtual_key is not None:
        process_env["D89_VIRTUAL_KEY"] = virtual_key
        command.extend(["-e", "D89_VIRTUAL_KEY"])
    command.extend(["litellm", "python", "-"])
    completed = subprocess.run(
        ["docker", "compose", *command],
        cwd=ROOT,
        env=process_env,
        check=True,
        capture_output=True,
        text=True,
        input=script,
    )
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise SystemExit("LiteLLM devolvió una respuesta no válida; no se mostró por seguridad") from error


def replace_env_values(updates: dict[str, str]) -> None:
    lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    seen: set[str] = set()
    output: list[str] = []
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else ""
        if key in updates:
            output.append(f"{key}={updates[key]}")
            seen.add(key)
        else:
            output.append(line)
    output.extend(f"{key}={value}" for key, value in updates.items() if key not in seen)
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


def main() -> None:
    values = load_env()
    require_value(values, "MOONSHOT_API_KEY")
    require_value(values, "LITELLM_MASTER_KEY")
    require_value(values, "LITELLM_SALT_KEY")
    current_key = values.get("LITELLM_D89_API_KEY", "").strip()
    if current_key and not current_key.startswith(PLACEHOLDERS):
        raise SystemExit("La clave D89 ya existe; no se generó otra clave ni se alteró .env")

    budget_usd = usd_budget(values)
    run_compose("--profile", "whatsapp", "up", "-d", "postgres", "litellm")
    request = json.dumps(
        {
            "key_alias": "d89-hermes",
            "models": ["kimi-k3"],
            "max_budget": float(budget_usd),
            "budget_duration": "monthly",
            "metadata": {
                "budget_currency": "MXN",
                "budget_mxn": values["LITELLM_MONTHLY_BUDGET_MXN"],
                "mxn_per_usd": values["LITELLM_MXN_PER_USD"],
                "rate_date": values["LITELLM_RATE_DATE"],
            },
        }
    )
    generate_script = f"""
import json, os, urllib.request
payload = {request!r}.encode()
request = urllib.request.Request(
    'http://127.0.0.1:4000/key/generate', data=payload,
    headers={{'Authorization': 'Bearer ' + os.environ['LITELLM_MASTER_KEY'],
             'Content-Type': 'application/json'}}, method='POST')
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.read().decode())
"""
    response = call_proxy(generate_script)
    virtual_key = str(response.get("key", ""))
    if not virtual_key.startswith("sk-"):
        raise SystemExit("LiteLLM no devolvió una clave virtual válida")
    returned_models = response.get("models", ["kimi-k3"])
    returned_budget = Decimal(str(response.get("max_budget", budget_usd)))
    if "kimi-k3" not in returned_models or returned_budget != budget_usd:
        raise SystemExit("LiteLLM no confirmó el modelo o presupuesto solicitado")

    verify_script = """
import json, os, urllib.request
request = urllib.request.Request(
    'http://127.0.0.1:4000/v1/models',
    headers={'Authorization': 'Bearer ' + os.environ['D89_VIRTUAL_KEY']})
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.read().decode())
"""
    models = call_proxy(verify_script, virtual_key=virtual_key)
    if not any(model.get("id") == "kimi-k3" for model in models.get("data", [])):
        raise SystemExit("La clave virtual no quedó restringida al alias kimi-k3")

    replace_env_values(
        {
            "LITELLM_D89_API_KEY": virtual_key,
            "LITELLM_MONTHLY_BUDGET_USD": str(budget_usd),
        }
    )
    print(
        "Clave virtual D89 provisionada sin exponerla: "
        f"tope mensual USD {budget_usd}, equivalente operativo a "
        f"MXN {values['LITELLM_MONTHLY_BUDGET_MXN']}"
    )


if __name__ == "__main__":
    main()
