#!/usr/bin/env python3
"""Provision D89's budgeted LiteLLM team and virtual keys without logging secrets.

One team carries the single monthly ceiling (LITELLM_MONTHLY_BUDGET_MXN); Hermes and
the API's document extraction get separate keys inside it, each restricted to its
own models. The master key never leaves the LiteLLM container.
"""

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


HERMES_MODELS = [
    "kimi-k3",
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "claude-sonnet-5",
    "claude-opus-5-5",
]
# Extraction aliases plus their fallback targets (see infra/litellm/config.yaml).
EXTRACTION_MODELS = ["d89-documentos", "d89-vision", "gemini-3.6-flash", "claude-sonnet-5"]
BUDGET_DURATION = "30d"


def is_provisioned(values: dict[str, str], key: str) -> bool:
    value = values.get(key, "").strip()
    return bool(value) and not value.startswith(PLACEHOLDERS)


def post_master(path: str, payload: dict[str, object]) -> dict[str, object]:
    request = json.dumps(payload)
    script = f"""
import json, os, urllib.request
payload = {request!r}.encode()
request = urllib.request.Request(
    'http://127.0.0.1:4000{path}', data=payload,
    headers={{'Authorization': 'Bearer ' + os.environ['LITELLM_MASTER_KEY'],
             'Content-Type': 'application/json'}}, method='POST')
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.read().decode())
"""
    return call_proxy(script)


def generate_key(alias: str, models: list[str], team_id: str, metadata: dict[str, str]) -> str:
    response = post_master(
        "/key/generate",
        {"key_alias": alias, "models": models, "team_id": team_id, "metadata": metadata},
    )
    virtual_key = str(response.get("key", ""))
    if not virtual_key.startswith("sk-"):
        raise SystemExit(f"LiteLLM no devolvió una clave virtual válida para {alias}")
    if not set(models).issubset(set(response.get("models", []))):
        raise SystemExit(f"LiteLLM no confirmó los modelos solicitados para {alias}")
    if response.get("team_id") != team_id:
        raise SystemExit(f"LiteLLM no asoció {alias} al equipo con presupuesto")

    verify_script = """
import json, os, urllib.request
request = urllib.request.Request(
    'http://127.0.0.1:4000/v1/models',
    headers={'Authorization': 'Bearer ' + os.environ['D89_VIRTUAL_KEY']})
with urllib.request.urlopen(request, timeout=30) as response:
    print(response.read().decode())
"""
    listed = call_proxy(verify_script, virtual_key=virtual_key)
    available = {model.get("id") for model in listed.get("data", [])}
    if available != set(models):
        raise SystemExit(f"La clave {alias} no quedó restringida a sus modelos autorizados")
    return virtual_key


def main() -> None:
    values = load_env()
    moonshot = values.get("MOONSHOT_API_KEY", "").strip()
    if not moonshot or moonshot.startswith(PLACEHOLDERS):
        # Only Hermes (profile `whatsapp`) uses kimi-k3; extraction does not need it.
        print("Aviso: MOONSHOT_API_KEY sin configurar; Hermes no podrá usar kimi-k3 hasta definirla")
    require_value(values, "GEMINI_API_KEY")
    require_value(values, "ANTHROPIC_API_KEY")
    require_value(values, "LITELLM_MASTER_KEY")
    require_value(values, "LITELLM_SALT_KEY")
    hermes_done = is_provisioned(values, "LITELLM_D89_API_KEY")
    extraction_done = is_provisioned(values, "LITELLM_EXTRACTION_API_KEY")
    team_done = is_provisioned(values, "LITELLM_TEAM_ID")
    if hermes_done and extraction_done:
        raise SystemExit("Las claves D89 ya existen; no se generó otra clave ni se alteró .env")
    if (hermes_done or extraction_done) and not team_done:
        # A key created before the shared team has its own ceiling: adding another
        # key would silently double the approved monthly budget.
        raise SystemExit(
            "Existe una clave sin equipo con presupuesto compartido; revócala en LiteLLM, "
            "vacía LITELLM_D89_API_KEY y vuelve a ejecutar este script"
        )

    budget_usd = usd_budget(values)
    run_compose("up", "-d", "postgres", "litellm")
    metadata = {
        "budget_currency": "MXN",
        "budget_mxn": values["LITELLM_MONTHLY_BUDGET_MXN"],
        "mxn_per_usd": values["LITELLM_MXN_PER_USD"],
        "rate_date": values["LITELLM_RATE_DATE"],
    }
    updates: dict[str, str] = {"LITELLM_MONTHLY_BUDGET_USD": str(budget_usd)}
    if team_done:
        team_id = values["LITELLM_TEAM_ID"].strip()
    else:
        team = post_master(
            "/team/new",
            {
                "team_alias": "d89",
                "max_budget": float(budget_usd),
                "budget_duration": BUDGET_DURATION,
                "models": sorted(set(HERMES_MODELS + EXTRACTION_MODELS)),
                "metadata": metadata,
            },
        )
        team_id = str(team.get("team_id", ""))
        returned_budget = Decimal(str(team.get("max_budget", "")))
        if not team_id or returned_budget != budget_usd:
            raise SystemExit("LiteLLM no confirmó el equipo o su presupuesto")
        updates["LITELLM_TEAM_ID"] = team_id
    if not hermes_done:
        updates["LITELLM_D89_API_KEY"] = generate_key(
            "d89-hermes", HERMES_MODELS, team_id, metadata
        )
    if not extraction_done:
        updates["LITELLM_EXTRACTION_API_KEY"] = generate_key(
            "d89-api-extraccion", EXTRACTION_MODELS, team_id, metadata
        )

    replace_env_values(updates)
    print(
        "Equipo y claves virtuales D89 provisionados sin exponerlos: "
        f"tope mensual compartido USD {budget_usd}, equivalente operativo a "
        f"MXN {values['LITELLM_MONTHLY_BUDGET_MXN']}"
    )


if __name__ == "__main__":
    main()
