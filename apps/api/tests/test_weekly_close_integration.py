"""Real database/API close tests; enable D89_RUN_FINANCIAL_INTEGRATION=1.

Reuse the disposable services and minimal Auth/Storage contracts from the
financial security suite. No running D89 database or environment file is used.
"""

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal

import jwt
import psycopg
import pytest
from fastapi.testclient import TestClient
from test_financial_security_integration import (
    BOOTSTRAP,
    MIGRATIONS,
    isolated_services,  # noqa: F401 -- shared pytest fixture
    one_line,
    seed,
)

from app.core.config import Settings, get_settings
from app.main import app


@pytest.mark.parametrize("installation", ["fresh", "upgrade"])
def test_weekly_close_lifecycle_and_locking(isolated_services, installation):  # noqa: F811
    services = isolated_services
    database = f"weekly_{installation}"
    with psycopg.connect(services["dsn"], autocommit=True) as admin:
        admin.execute(
            psycopg.sql.SQL("create database {}").format(psycopg.sql.Identifier(database))
        )
    dsn = services["dsn"].removesuffix("postgres") + database
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(BOOTSTRAP)
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path.name == "202609270002_weekly_close_revisions.sql" and installation == "upgrade":
                ids = seed(connection)
                historical_id = connection.execute(
                    """insert into public.cierre_semanal(obra_id,anio_iso,semana_iso,cerrado_por)
                       values (%s,2026,36,%s) returning id""",
                    (ids["work"], ids["admin"]),
                ).fetchone()[0]
                connection.execute(
                    """insert into public.cierre_semanal_gasto
                       (cierre_id,gasto_id,importe_al_cierre,estado_al_cierre)
                       values (%s,%s,125,'validado')""",
                    (historical_id, ids["legacy"]),
                )
            connection.execute(path.read_text())
        if installation == "fresh":
            ids = seed(connection)
        else:
            assert connection.execute(
                """select revision,importe_al_cierre from public.cierre_semanal_gasto
                   where cierre_id=%s""",
                (historical_id,),
            ).fetchone() == (1, Decimal(125))

        settings = Settings(_env_file=None, database_url=dsn, jwt_secret=services["secret"])
        previous = app.dependency_overrides.copy()
        app.dependency_overrides[get_settings] = lambda: settings

        def headers(role):
            return {
                "Authorization": "Bearer "
                + jwt.encode(
                    {
                        "sub": str(ids[role]),
                        "aud": "authenticated",
                        "exp": int(time.time()) + 600,
                        "app_metadata": {"role": "admin" if role == "admin" else "operativo"},
                    },
                    services["secret"],
                    algorithm="HS256",
                )
            }

        payload = {
            "work_id": str(ids["work"]),
            "area_id": str(ids["area"]),
            "expense_item_id": str(ids["item"]),
            "expense_subitem_id": str(ids["subitem"]),
            "expense_category_id": str(ids["category"]),
            "supplier_id": str(ids["supplier"]),
            "spent_on": "2021-01-01",
            "concept": "ISO year boundary",
            "lines": one_line("100.00"),
        }
        close_payload = {"work_id": str(ids["work"]), "iso_year": 2020, "iso_week": 53}
        preview_url = f"/api/v1/works/{ids['work']}/weekly-closes/preview"
        try:
            with TestClient(app) as api:

                def create(values=None, role="admin"):
                    return api.post(
                        "/api/v1/expenses",
                        json={**payload, **(values or {})},
                        headers=headers(role),
                    )

                def close():
                    return api.post(
                        "/api/v1/weekly-closes", json=close_payload, headers=headers("admin")
                    )

                def review(expense_id, action, reason=None):
                    return api.post(
                        f"/api/v1/expenses/{expense_id}/review",
                        json={"action": action, "reason": reason},
                        headers=headers("admin"),
                    )

                def preview(role="admin", year=2020, week=53):
                    return api.get(
                        preview_url,
                        params={"iso_year": year, "iso_week": week},
                        headers=headers(role),
                    )

                response = create(role="operativo")
                assert response.status_code == 201, response.text
                expense_id = response.json()["id"]
                # Pending prevents closing; invalid real ISO week fails with 422.
                assert close().status_code == 409
                assert preview(year=2021, week=53).status_code == 422
                assert (
                    api.post(
                        "/api/v1/weekly-closes",
                        json={**close_payload, "iso_year": 2021},
                        headers=headers("admin"),
                    ).status_code
                    == 422
                )
                path = f"{ids['work']}/{expense_id}/receipt.pdf"
                connection.execute(
                    "insert into storage.objects(bucket_id,name) values ('comprobantes',%s)",
                    (path,),
                )
                assert (
                    api.patch(
                        f"/api/v1/expenses/{expense_id}/receipt",
                        json={"path": path},
                        headers=headers("operativo"),
                    ).status_code
                    == 200
                )
                assert review(expense_id, "validate").status_code == 200
                rejected_id = create({"lines": one_line("777")}).json()["id"]
                assert (
                    api.post(
                        f"/api/v1/expenses/{rejected_id}/review",
                        json={"action": "reject", "reason": "No corresponde al presupuesto"},
                        headers=headers("admin"),
                    ).status_code
                    == 200
                )
                result = close()
                assert result.status_code == 201, result.text
                close_id = result.json()["id"]
                assert result.json()["revision"] == 1
                assert result.json()["expense_count"] == 1
                assert close().status_code == 409
                for role in ("admin", "operativo"):
                    assert create(role=role).status_code == 409
                # Source AND target week protection (not just old expense date).
                edit = {k: v for k, v in payload.items() if k != "work_id"}
                assert (
                    api.patch(
                        f"/api/v1/expenses/{rejected_id}",
                        json={**edit, "spent_on": "2021-01-04"},
                        headers=headers("admin"),
                    ).status_code
                    == 409
                )
                other = create({"spent_on": "2021-01-04"}, "operativo")
                assert other.status_code == 201
                assert (
                    api.patch(
                        f"/api/v1/expenses/{other.json()['id']}",
                        json=edit,
                        headers=headers("operativo"),
                    ).status_code
                    == 409
                )
                returned = review(expense_id, "return_to_review", "Corrección tras cierre")
                assert returned.status_code == 409, returned.text
                data = preview().json()
                assert data["date_from"] == "2020-12-28" and data["date_to"] == "2021-01-03"
                assert Decimal(data["summary"]["amount"]) == 100
                assert Decimal(data["summary"]["rechazado"]["amount"]) == 777
                assert preview("outsider").status_code == 403
                assert preview("operativo").json()["permissions"]["can_manage"] is False
                assert (
                    api.post(
                        "/api/v1/weekly-closes", json=close_payload, headers=headers("operativo")
                    ).status_code
                    == 403
                )
                reopen_url = f"/api/v1/weekly-closes/{close_id}/reopen"
                assert (
                    api.post(
                        reopen_url, json={"reason": " " * 12}, headers=headers("admin")
                    ).status_code
                    == 422
                )
                assert (
                    api.post(
                        reopen_url,
                        json={"reason": "Corrección documentada de importe"},
                        headers=headers("admin"),
                    ).status_code
                    == 200
                )
                assert (
                    api.post(
                        reopen_url,
                        json={"reason": "Reapertura repetida inválida"},
                        headers=headers("admin"),
                    ).status_code
                    == 409
                )
                assert review(expense_id, "return_to_review", "Corregir importe").status_code == 200
                updated = api.patch(
                    f"/api/v1/expenses/{expense_id}",
                    json={**edit, "lines": one_line("250")},
                    headers=headers("operativo"),
                )
                assert updated.status_code == 200, updated.text
                assert close().status_code == 409
                assert review(expense_id, "validate").status_code == 200
                reclosed = close()
                assert reclosed.status_code == 201, reclosed.text
                assert reclosed.json()["id"] == close_id and reclosed.json()["revision"] == 2
                snapshots = connection.execute(
                    """select revision,importe_al_cierre from public.cierre_semanal_gasto
                       where cierre_id=%s order by revision""",
                    (close_id,),
                ).fetchall()
                assert snapshots == [(1, Decimal(100)), (2, Decimal(250))]
                data = preview().json()
                assert Decimal(data["summary"]["amount"]) == 250
                assert [event["accion"] for event in data["history"]] == [
                    "cerrar_lote",
                    "reabrir",
                    "cerrar_lote",
                ]
                assert [event["detalle_json"]["revision"] for event in data["history"]] == [1, 1, 2]
                assert all(event["autor"] == "Test admin" for event in data["history"])
                listed = api.get(
                    f"/api/v1/works/{ids['work']}/weekly-closes", headers=headers("admin")
                ).json()
                current = next(row for row in listed if row["id"] == close_id)
                assert Decimal(current["amount"]) == 250 and current["expense_count"] == 1
                assert preview(year=2021, week=2).json()["expenses"] == []
                # Simultaneous creation/closing must never leave a pending expense in a closed week.
                for day in (11, 18, 25):
                    spent_on = date(2021, 1, day)
                    year, week, _ = spent_on.isocalendar()
                    with ThreadPoolExecutor(max_workers=2) as pool:
                        creation = pool.submit(create, {"spent_on": str(spent_on)})
                        closing = pool.submit(
                            api.post,
                            "/api/v1/weekly-closes",
                            json={**close_payload, "iso_year": year, "iso_week": week},
                            headers=headers("admin"),
                        )
                        assert sorted(
                            [creation.result().status_code, closing.result().status_code]
                        ) == [201, 409]
                    data = preview(year=year, week=week).json()
                    assert not (
                        data["close"]
                        and data["close"]["estado"] == "cerrado"
                        and data["summary"]["pendiente"]["count"]
                    )
        finally:
            app.dependency_overrides.clear()
            app.dependency_overrides.update(previous)
