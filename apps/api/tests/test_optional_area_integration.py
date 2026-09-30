"""Cambio 8 on real PostgreSQL: expenses without a NEODATA area, end to end.

Run with D89_RUN_FINANCIAL_INTEGRATION=1 (disposable Docker services, never .env).
"""

import io
import time
from decimal import Decimal
from uuid import uuid4

import jwt
import openpyxl
import psycopg
import pytest
from fastapi.testclient import TestClient
from test_financial_security_integration import (
    BOOTSTRAP,
    MIGRATIONS,
    isolated_services,  # noqa: F401 -- shared disposable pytest fixture
    seed,
)

from app.core.config import Settings, get_settings
from app.main import app

MIGRATION = MIGRATIONS / "202609300001_optional_expense_area.sql"
LINES = [{"quantity": "1", "unit": "servicio", "description": "Firme", "unit_price": "116"}]


@pytest.mark.parametrize("installation", ["fresh", "upgrade"])
def test_expense_without_area_end_to_end(isolated_services, installation):  # noqa: F811
    services = isolated_services
    database = f"optional_area_{installation}"
    with psycopg.connect(services["dsn"], autocommit=True) as admin:
        admin.execute(
            psycopg.sql.SQL("create database {}").format(psycopg.sql.Identifier(database))
        )
    dsn = services["dsn"].removesuffix("postgres") + database
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(BOOTSTRAP)
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path == MIGRATION and installation == "upgrade":
                ids = seed(connection)  # legacy expense with an area, before the change
            connection.execute(path.read_text())
        if installation == "fresh":
            ids = seed(connection)
        # Idempotent and data preserving; legacy expenses keep their area.
        connection.execute(MIGRATION.read_text())
        assert connection.execute(
            "select area_id from public.gasto where id=%s", (ids["legacy"],)
        ).fetchone()[0] == ids["area"]
        assert connection.execute(
            """select is_nullable from information_schema.columns
               where table_name='gasto' and column_name='area_id'"""
        ).fetchone()[0] == "YES"

        def headers(role):
            return {"Authorization": "Bearer " + jwt.encode(
                {"sub": str(ids[role]), "role": "authenticated", "aud": "authenticated",
                 "app_metadata": {"role": "admin" if role == "admin" else "operativo"},
                 "exp": int(time.time()) + 600},
                services["secret"], algorithm="HS256",
            )}

        base = {
            "work_id": str(ids["work"]), "expense_item_id": str(ids["item"]),
            "expense_subitem_id": str(ids["subitem"]),
            "expense_category_id": str(ids["category"]), "supplier_id": str(ids["supplier"]),
            "spent_on": "2026-09-29", "concept": "Firme sin área", "lines": LINES,
        }
        settings = Settings(_env_file=None, database_url=dsn, jwt_secret=services["secret"])
        previous = app.dependency_overrides.copy()
        app.dependency_overrides[get_settings] = lambda: settings
        try:
            with TestClient(app) as api:
                created = api.post("/api/v1/expenses", json=base, headers=headers("operativo"))
                assert created.status_code == 201, created.text
                expense = created.json()
                assert expense["area_path"] == [] and expense["amount"] == "116.0000"
                expense_id = expense["id"]
                assert connection.execute(
                    "select area_id from public.gasto where id=%s", (expense_id,)
                ).fetchone()[0] is None

                # It is visible everywhere an inner join used to hide it.
                assert api.get(
                    f"/api/v1/expenses/{expense_id}", headers=headers("operativo")
                ).json()["area_path"] == []
                page = api.get(
                    f"/api/v1/works/{ids['work']}/expenses", headers=headers("operativo")
                ).json()
                row = next(item for item in page["items"] if item["id"] == expense_id)
                assert row["area_id"] is None and row["area"] is None
                assert row["partida"] and row["subpartida"] and row["categoria"]
                legacy_list = api.get(
                    "/api/v1/expenses", params={"work_id": str(ids["work"])},
                    headers=headers("operativo"),
                ).json()
                assert next(r for r in legacy_list if r["id"] == expense_id)["area"] == "Sin área"
                report = api.get(
                    f"/api/v1/reports/works/{ids['work']}.xlsx", headers=headers("admin")
                )
                assert report.status_code == 200
                sheet = openpyxl.load_workbook(io.BytesIO(report.content)).active
                values = [[cell.value for cell in line] for line in sheet.iter_rows()]
                assert any("Firme sin área" in line and "Sin área" in line for line in values)
                preview = api.get(
                    f"/api/v1/works/{ids['work']}/weekly-closes/preview",
                    params={"iso_year": 2026, "iso_week": 40}, headers=headers("admin"),
                )
                assert preview.status_code == 200, preview.text
                assert expense_id in preview.text

                # A NEODATA budget item needs an area (API and database).
                assert api.post(
                    "/api/v1/expenses", json={**base, "budget_item_id": str(uuid4())},
                    headers=headers("admin"),
                ).status_code == 422
                clase = connection.execute(
                    "insert into public.catalogo_clase(nombre) values ('Clase prueba') "
                    "returning id"
                ).fetchone()[0]
                partida = connection.execute(
                    "insert into public.catalogo_partida(clase_id,codigo,descripcion,unidad) "
                    "values (%s,'P-1','Partida prueba','m2') returning id", (clase,),
                ).fetchone()[0]
                with pytest.raises(psycopg.errors.CheckViolation):
                    connection.execute(
                        "update public.gasto set partida_id=%s where id=%s",
                        (partida, expense_id),
                    )

                # Linking and unlinking the area on edit.
                edit = {k: v for k, v in base.items() if k != "work_id"}
                linked = api.patch(
                    f"/api/v1/expenses/{expense_id}", json={**edit, "area_id": str(ids["area"])},
                    headers=headers("operativo"),
                )
                assert linked.status_code == 200, linked.text
                assert linked.json()["area_path"] == ["TEST"]
                unlinked = api.patch(
                    f"/api/v1/expenses/{expense_id}", json={**edit, "area_id": None},
                    headers=headers("operativo"),
                )
                assert unlinked.status_code == 200 and unlinked.json()["area_path"] == []
                foreign = api.patch(
                    f"/api/v1/expenses/{expense_id}", json={**edit, "area_id": str(uuid4())},
                    headers=headers("operativo"),
                )
                assert foreign.status_code == 422

                # Summary: NEODATA budget untouched; spend grouped by item and category.
                overview = api.get(
                    f"/api/v1/works/{ids['work']}/overview", params={"to": "2026-09-30"},
                    headers=headers("operativo"),
                ).json()
                assert Decimal(str(overview["totals"]["validated"])) == Decimal("125")
                item_name = connection.execute(
                    "select nombre from public.catalogo_partida_gasto where id=%s", (ids["item"],)
                ).fetchone()[0]
                by_item = {row["name"]: row for row in overview["by_item"]}
                assert Decimal(str(by_item[item_name]["pending"])) == Decimal("116")
                assert by_item[item_name]["expense_count"] == 1
                # The legacy expense has no catalog classification.
                assert Decimal(str(by_item["Sin partida"]["validated"])) == Decimal("125")
                [subitem] = by_item[item_name]["subitems"]
                assert subitem["id"] == str(ids["subitem"])
                assert Decimal(str(subitem["pending"])) == Decimal("116")
                [subitem_category] = subitem["categories"]
                assert subitem_category["id"] == str(ids["category"])
                assert Decimal(str(subitem_category["pending"])) == Decimal("116")
                providers = {row["name"]: row for row in overview["by_provider"]}
                assert providers["Test"]["expense_count"] == 1
                assert Decimal(str(providers["Test"]["pending"])) == Decimal("116")
                assert Decimal(str(providers["Sin proveedor"]["validated"])) == Decimal("125")
                assert Decimal(str(providers["Sin proveedor"]["share_percent"])) == Decimal("100")
                names = [row["name"] for row in overview["by_category"]]
                assert names[:3] == ["MATERIAL", "MANO DE OBRA", "EQUIPO/HERR"]
                assert sum(
                    Decimal(str(row["committed"])) for row in overview["by_category"]
                ) == Decimal("241")
        finally:
            app.dependency_overrides.clear()
            app.dependency_overrides.update(previous)
