from datetime import date
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
BASE_URL = "http://127.0.0.1:3089"


def load_env() -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if raw_line and not raw_line.startswith("#") and "=" in raw_line:
            key, value = raw_line.split("=", 1)
            values[key] = value
    return values


def require(response: httpx.Response, expected: int = 200) -> dict | list:
    if response.status_code != expected:
        raise SystemExit(
            f"Flujo live falló: {response.request.method} {response.request.url.path} "
            f"devolvió {response.status_code}: {response.text[:500]}"
        )
    return response.json()


def main() -> None:
    env = load_env()
    workbook = next(ROOT.parent.glob("20260816*.xlsx"), None)
    if workbook is None:
        raise SystemExit("No se encontró el Excel real externo esperado")
    with httpx.Client(base_url=BASE_URL, timeout=120) as client:
        session = require(
            client.post(
                "/auth/v1/token?grant_type=password",
                headers={"apikey": env["ANON_KEY"]},
                json={
                    "email": env["STAGING_ADMIN_EMAIL"],
                    "password": env["STAGING_ADMIN_PASSWORD"],
                },
            )
        )
        assert isinstance(session, dict)
        auth = {"Authorization": f"Bearer {session['access_token']}"}
        works = require(client.get("/api/v1/works", headers=auth))
        assert isinstance(works, list) and works
        work_id = works[0]["id"]
        with workbook.open("rb") as stream:
            imported = require(
                client.post(
                    "/api/v1/neodata/preview",
                    headers=auth,
                    data={"work_id": work_id, "import_type": "inicial"},
                    files={
                        "file": (
                            workbook.name,
                            stream,
                            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                        )
                    },
                ),
                200,
            )
        assert isinstance(imported, dict)
        preview = imported["preview"]
        assert preview["item_count"] == 232
        assert preview["area_count"] == 3
        assert preview["section_total_count"] == 40
        assert not preview["unclassified"]
        assert not preview["section_mismatches"]
        confirmed = require(
            client.post(
                f"/api/v1/neodata/imports/{imported['id']}/confirm",
                headers=auth,
                json={"confirmation": True},
            )
        )
        assert isinstance(confirmed, dict) and confirmed["item_count"] == 232
        catalog = require(client.get(f"/api/v1/works/{work_id}/catalog", headers=auth))
        assert isinstance(catalog, dict) and len(catalog["items"]) == 232
        area = catalog["areas"][0]
        expense_partida = catalog["expense_partidas"][0]
        expense_subitem = next(
            item
            for item in catalog["expense_subitems"]
            if item["partida_id"] == expense_partida["id"]
        )
        expense_category = catalog["expense_categories"][0]
        expense = require(
            client.post(
                "/api/v1/expenses",
                headers=auth,
                json={
                    "work_id": work_id,
                    "area_id": area["id"],
                    "expense_item_id": expense_partida["id"],
                    "expense_subitem_id": expense_subitem["id"],
                    "expense_category_id": expense_category["id"],
                    "supplier_name": "Proveedor validación D89",
                    "spent_on": date(2026, 8, 30).isoformat(),
                    "concept": "Validación integral staging D89",
                    "amount": "18450.00",
                    "state": "pendiente",
                },
            ),
            201,
        )
        assert isinstance(expense, dict)
        closed = require(
            client.post(
                "/api/v1/weekly-closes",
                headers=auth,
                json={"work_id": work_id, "iso_year": 2026, "iso_week": 35},
            ),
            201,
        )
        assert isinstance(closed, dict) and closed["expense_count"] == 1
        reopened = require(
            client.post(
                f"/api/v1/weekly-closes/{closed['id']}/reopen",
                headers=auth,
                json={"reason": "Validación de reapertura auditada en staging"},
            )
        )
        assert isinstance(reopened, dict) and reopened["estado"] == "reabierto"
        with workbook.open("rb") as stream:
            duplicate = client.post(
                "/api/v1/neodata/preview",
                headers=auth,
                data={"work_id": work_id, "import_type": "nueva_version"},
                files={"file": (workbook.name, stream)},
            )
        if duplicate.status_code != 409:
            raise SystemExit(f"Se esperaba rechazo 409 de duplicado; llegó {duplicate.status_code}")
    print("Flujo live aprobado: auth, 232 partidas, gasto, cierre, reapertura y duplicado 409")


if __name__ == "__main__":
    main()
