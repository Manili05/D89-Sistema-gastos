"""Real PostgreSQL/PostgREST, disposable Docker services, never the staging .env.

Run with D89_RUN_FINANCIAL_INTEGRATION=1. Reuses the minimal Auth/Storage fixtures
from financial security tests; file existence is real, uploading bytes is not covered.
"""

import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
from uuid import uuid4

import httpx
import jwt
import psycopg
import pytest
from fastapi.testclient import TestClient
from test_financial_security_integration import (
    BOOTSTRAP,
    MIGRATIONS,
    docker,
    isolated_services,  # noqa: F401 -- shared disposable pytest fixture
    seed,
)

from app.core.config import Settings, get_settings
from app.main import app

MIGRATION = MIGRATIONS / "202609290001_income_module.sql"


@pytest.mark.parametrize("installation", ["fresh", "upgrade"])
def test_income_api_migration_and_postgrest_security(isolated_services, installation):  # noqa: F811
    services = isolated_services
    database = f"income_{installation}"
    with psycopg.connect(services["dsn"], autocommit=True) as admin:
        admin.execute(
            psycopg.sql.SQL("create database {}").format(psycopg.sql.Identifier(database))
        )
    dsn = services["dsn"].removesuffix("postgres") + database
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(BOOTSTRAP)
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path == MIGRATION and installation == "upgrade":
                ids = seed(connection)
                legacy_ids = []
                for state in ("por_cobrar", "cobrado"):
                    row = connection.execute(
                        """insert into public.ingreso
                           (obra_id,concepto,fecha_estimada,fecha_real,monto,estado,creado_por)
                           values (%s,'Histórico','2026-09-01','2026-09-02',10.1234,%s,%s)
                           returning id""",
                        (ids["work"], state, ids["admin"]),
                    ).fetchone()
                    legacy_ids.append(row[0])
            connection.execute(path.read_text())
        if installation == "fresh":
            ids = seed(connection)
        else:
            for income_id, state in zip(legacy_ids, ("pendiente", "conciliado"), strict=True):
                row = connection.execute(
                    "select fecha,fecha_real,importe,estado,folio from public.ingreso where id=%s",
                    (income_id,),
                ).fetchone()
                assert row[:4] == (date(2026, 9, 1), date(2026, 9, 2), Decimal("10.1234"), state)
                assert row[4].startswith("I-")

        # Reapplying preserves rows and never rewinds a consumed sequence value.
        before = connection.execute("select * from public.ingreso order by id").fetchall()
        connection.execute("select nextval('public.ingreso_folio_seq')")
        sequence = connection.execute("select last_value from public.ingreso_folio_seq").fetchone()
        connection.execute(MIGRATION.read_text())
        assert connection.execute("select * from public.ingreso order by id").fetchall() == before
        assert (
            connection.execute("select last_value from public.ingreso_folio_seq").fetchone()
            == sequence
        )
        for role in ("anon", "authenticated"):
            for table in ("ingreso", "ingreso_comprobante"):
                for privilege in ("INSERT", "UPDATE", "DELETE"):
                    assert not connection.execute(
                        "select has_table_privilege(%s,%s,%s)",
                        (role, table, privilege),
                    ).fetchone()[0]

        def headers(role):
            if role is None:
                return {}
            return {
                "Authorization": "Bearer "
                + jwt.encode(
                    {
                        "sub": str(ids[role]),
                        "role": "authenticated",
                        "aud": "authenticated",
                        "app_metadata": {"role": "admin" if role == "admin" else "operativo"},
                        "exp": int(time.time()) + 600,
                    },
                    services["secret"],
                    algorithm="HS256",
                )
            }

        settings = Settings(_env_file=None, database_url=dsn, jwt_secret=services["secret"])
        previous = app.dependency_overrides.copy()
        app.dependency_overrides[get_settings] = lambda: settings
        url = f"/api/v1/works/{ids['work']}/incomes"
        payload = {"received_on": "2026-09-29", "concept": "Anticipo", "amount": "1234.5678"}
        try:
            with TestClient(app) as api:
                for role, expected in ((None, 401), ("operativo", 403), ("outsider", 403)):
                    assert (
                        api.post(url, json=payload, headers=headers(role)).status_code == expected
                    )
                assert (
                    api.post(
                        f"/api/v1/works/{uuid4()}/incomes",
                        json=payload,
                        headers=headers("admin"),
                    ).status_code
                    == 403
                )
                for changes in ({"amount": "0.00001"}, {"folio": "I-99999"}, {"state": "validado"}):
                    assert (
                        api.post(
                            url,
                            json={**payload, **changes},
                            headers=headers("admin"),
                        ).status_code
                        == 422
                    )
                created = api.post(url, json=payload, headers=headers("admin"))
                assert created.status_code == 201, created.text
                income = created.json()
                income_id = income["id"]
                assert income["amount"] == "1234.5678" and income["state"] == "pendiente"
                assert income["work_id"] == str(ids["work"]) and income["receipts"] == []
                assert income["folio"] == f"I-{sequence[0] + 1:05d}"
                assert connection.execute(
                    "select importe from public.ingreso where id=%s",
                    (income_id,),
                ).fetchone()[0] == Decimal("1234.5678")
                for role in ("admin", "operativo"):
                    listed = api.get(url, headers=headers(role))
                    assert listed.status_code == 200 and income in listed.json()
                    assert (
                        api.get(
                            f"/api/v1/incomes/{income_id}",
                            headers=headers(role),
                        ).json()
                        == income
                    )
                assert api.get(url, headers=headers("outsider")).status_code == 403
                assert (
                    api.get(
                        f"/api/v1/incomes/{income_id}",
                        headers=headers("outsider"),
                    ).status_code
                    == 403
                )
                assert (
                    api.get(
                        f"/api/v1/incomes/{uuid4()}",
                        headers=headers("admin"),
                    ).status_code
                    == 404
                )

                receipt_url = f"/api/v1/incomes/{income_id}/receipts"
                receipt_path = f"{ids['work']}/{income_id}/transferencia.pdf"
                for invalid_path in (
                    receipt_path,
                    f"{uuid4()}/{income_id}/ajeno.pdf",
                    f"{ids['work']}/{uuid4()}/ajeno.pdf",
                    f"{ids['work']}/{income_id}/../transferencia.pdf",
                    f"{ids['work']}/{income_id}/archivo.exe",
                ):
                    response = api.post(
                        receipt_url,
                        json={"path": invalid_path},
                        headers=headers("admin"),
                    )
                    assert response.status_code == 422, response.text
                for role in ("operativo", "outsider"):
                    assert (
                        api.post(
                            receipt_url,
                            json={"path": receipt_path},
                            headers=headers(role),
                        ).status_code
                        == 403
                    )
                receipt_paths = [receipt_path, f"{ids['work']}/{income_id}/factura.xml"]
                for path in receipt_paths:
                    connection.execute(
                        "insert into storage.objects(bucket_id,name) values ('comprobantes',%s)",
                        (path,),
                    )
                    for _ in range(2):
                        linked = api.post(
                            receipt_url, json={"path": path}, headers=headers("admin")
                        )
                        assert linked.status_code == 200, linked.text
                assert [r["kind"] for r in linked.json()["receipts"]] == ["pdf", "xml"]
                receipt_id = linked.json()["receipts"][0]["id"]
                assert (
                    connection.execute(
                        "select count(*) from public.audit_log_negocio where entidad='ingreso' "
                        "and entidad_id=%s",
                        (income_id,),
                    ).fetchone()[0]
                    == 3
                )  # create + two distinct receipts

                # Reconciliation: admin only, needs a stored receipt, revert needs a reason.
                bare = api.post(url, json=payload, headers=headers("admin")).json()
                status_url = f"/api/v1/incomes/{income_id}/status"
                reconcile = {"state": "conciliado"}
                assert api.patch(
                    f"/api/v1/incomes/{bare['id']}/status", json=reconcile,
                    headers=headers("admin"),
                ).status_code == 422
                for role, expected in ((None, 401), ("operativo", 403), ("outsider", 403)):
                    assert api.patch(
                        status_url, json=reconcile, headers=headers(role)
                    ).status_code == expected
                done = api.patch(status_url, json=reconcile, headers=headers("admin"))
                assert done.status_code == 200, done.text
                assert done.json()["state"] == "conciliado"
                assert done.json()["reconciled_by"] == "Test admin"
                assert done.json()["reconciled_at"]
                assert api.patch(
                    status_url, json=reconcile, headers=headers("admin")
                ).status_code == 409
                assert api.patch(
                    status_url, json={"state": "pendiente"}, headers=headers("admin")
                ).status_code == 422
                reverted = api.patch(
                    status_url, json={"state": "pendiente", "reason": "Depósito duplicado"},
                    headers=headers("admin"),
                )
                assert reverted.status_code == 200, reverted.text
                assert reverted.json()["state"] == "pendiente"
                assert reverted.json()["reconciled_by"] is None
                assert reverted.json()["reversal_reason"] == "Depósito duplicado"

                batch_url = "/api/v1/incomes/reconcile-batch"
                batch = {"work_id": str(ids["work"]), "income_ids": [income_id, bare["id"]]}
                assert api.post(batch_url, json=batch, headers=headers("operativo")).status_code \
                    == 403
                assert api.post(batch_url, json=batch, headers=headers("admin")).status_code == 422
                assert connection.execute(
                    "select estado::text from public.ingreso where id=%s", (income_id,)
                ).fetchone()[0] == "pendiente"  # all or nothing
                assert api.post(
                    batch_url, json={"work_id": str(uuid4()), "income_ids": [income_id]},
                    headers=headers("admin"),
                ).status_code == 403
                batched = api.post(
                    batch_url, json={**batch, "income_ids": [income_id]}, headers=headers("admin")
                )
                assert batched.status_code == 200 and batched.json()["reconciled"] == 1
                actions = [row[0] for row in connection.execute(
                    "select accion from public.audit_log_negocio where entidad='ingreso' "
                    "and entidad_id=%s order by creado_en, id",
                    (income_id,),
                ).fetchall()]
                assert actions[-3:] == ["conciliar", "revertir_conciliacion", "conciliar_lote"]

                overview = api.get(
                    f"/api/v1/works/{ids['work']}/overview",
                    params={"to": "2026-09-30"}, headers=headers("operativo"),
                )
                assert overview.status_code == 200, overview.text
                incomes = overview.json()["incomes"]
                legacy_offset = Decimal("10.1234") if installation == "upgrade" else Decimal("0")
                assert Decimal(str(incomes["reconciled"])) == Decimal("1234.5678") + legacy_offset
                assert Decimal(str(incomes["pending"])) == Decimal("1234.5678") + legacy_offset
                assert incomes["count"] == (4 if installation == "upgrade" else 2)

                # Existing cashflow clients and dashboard still work after the rename.
                legacy = api.post(
                    "/api/v1/incomes",
                    headers=headers("admin"),
                    json={
                        "work_id": str(ids["work"]),
                        "concept": "Estimación 1",
                        "estimated_date": "2026-09-20",
                        "actual_date": "2026-09-21",
                        "amount": "50.1250",
                        "state": "cobrado",
                    },
                )
                assert legacy.status_code == 201 and legacy.json()["estado"] == "cobrado"
                old_list = api.get(
                    "/api/v1/incomes",
                    params={"work_id": str(ids["work"])},
                    headers=headers("admin"),
                )
                assert any(row["id"] == legacy.json()["id"] for row in old_list.json())
                dashboard = api.get("/api/v1/dashboard", headers=headers("admin"))
                assert dashboard.status_code == 200, dashboard.text
                # The legacy estimation plus the income reconciled above.
                expected_collected = Decimal("50.1250") + Decimal("1234.5678")
                if installation == "upgrade":
                    expected_collected += Decimal("10.1234")
                assert Decimal(str(dashboard.json()["totals"]["collected"])) == expected_collected

                # Sequence is not truncated at six digits, even with concurrent creates.
                connection.execute("select setval('public.ingreso_folio_seq',99999)")
                with ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(
                        pool.map(
                            lambda _: api.post(
                                url,
                                json={**payload, "state": "conciliado"},
                                headers=headers("admin"),
                            ),
                            range(4),
                        )
                    )
                assert all(result.status_code == 201 for result in results)
                assert {result.json()["folio"] for result in results} == {
                    "I-100000",
                    "I-100001",
                    "I-100002",
                    "I-100003",
                }
        finally:
            app.dependency_overrides.clear()
            app.dependency_overrides.update(previous)

        docker(
            "run",
            "--detach",
            "--rm",
            "--pull=never",
            "--name",
            services["rest_name"],
            "--memory=128m",
            "--cpus=0.5",
            "--network",
            f"container:{services['pg_name']}",
            "--env",
            f"PGRST_DB_URI=postgres://postgres:{services['password']}@127.0.0.1:5432/{database}",
            "--env",
            "PGRST_DB_SCHEMAS=public",
            "--env",
            "PGRST_DB_ANON_ROLE=anon",
            "--env",
            f"PGRST_JWT_SECRET={services['secret']}",
            "postgrest/postgrest:v13.0.7",
        )
        services["started"].append(services["rest_name"])
        try:
            with httpx.Client(base_url=services["rest_url"], timeout=5) as rest:
                for attempt in range(100):
                    try:
                        if rest.get("/").status_code == 200:
                            break
                    except httpx.TransportError:
                        pass
                    if attempt == 99:
                        pytest.fail("Isolated PostgREST did not start")
                    time.sleep(0.2)
                for table in ("ingreso", "ingreso_comprobante"):
                    for role in ("admin", "operativo"):
                        response = rest.get(f"/{table}", headers=headers(role))
                        assert response.status_code == 200 and response.json()
                    response = rest.get(f"/{table}", headers=headers("outsider"))
                    assert response.status_code == 200 and response.json() == []
                snapshots = {
                    table: connection.execute(
                        f"select * from public.{table} order by id"
                    ).fetchall()
                    for table in ("ingreso", "ingreso_comprobante")
                }
                for grant_writes in (False, True):
                    if grant_writes:
                        connection.execute("grant usage on schema public to anon")
                        connection.execute(
                            "grant select,insert,update,delete on public.ingreso, "
                            "public.ingreso_comprobante to anon,authenticated; "
                            "grant usage on sequence public.ingreso_folio_seq to anon,authenticated"
                        )
                        for table in snapshots:
                            connection.execute(
                                f"create policy test_permissive on public.{table} "
                                "for all to anon,authenticated "
                                "using (true) with check (true)"
                            )
                    for role in (None, "admin", "operativo", "outsider"):
                        for table, row_id, insert, patch in (
                            (
                                "ingreso",
                                income_id,
                                {
                                    "obra_id": str(ids["work"]),
                                    "concepto": "Intento directo",
                                    "fecha": "2026-09-29",
                                    "importe": "100",
                                    "estado": "conciliado",
                                    "creado_por": str(ids["admin"]),
                                },
                                {"importe": "999999", "estado": "conciliado"},
                            ),
                            (
                                "ingreso_comprobante",
                                receipt_id,
                                {
                                    "ingreso_id": income_id,
                                    "ruta": f"direct-{uuid4()}.pdf",
                                    "tipo": "pdf",
                                    "creado_por": str(ids["admin"]),
                                },
                                {"ruta": "reemplazado.pdf"},
                            ),
                        ):
                            response = rest.post(f"/{table}", json=insert, headers=headers(role))
                            assert response.status_code in (401, 403), response.text
                            for method, body in (("PATCH", patch), ("DELETE", None)):
                                response = rest.request(
                                    method,
                                    f"/{table}",
                                    params={"id": f"eq.{row_id}"},
                                    json=body,
                                    headers={**headers(role), "Prefer": "return=representation"},
                                )
                                if grant_writes:
                                    assert response.status_code == 200 and response.json() == []
                                else:
                                    assert response.status_code in (401, 403), response.text
                    for table, snapshot in snapshots.items():
                        assert (
                            connection.execute(
                                f"select * from public.{table} order by id",
                            ).fetchall()
                            == snapshot
                        )
                connection.execute("delete from public.ingreso where id=%s", (income_id,))
                assert (
                    connection.execute(
                        "select count(*) from public.ingreso_comprobante where ingreso_id=%s",
                        (income_id,),
                    ).fetchone()[0]
                    == 0
                )
        finally:
            docker("stop", "--time", "2", services["rest_name"])
            services["started"].remove(services["rest_name"])
