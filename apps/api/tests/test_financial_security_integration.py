"""Opt-in real PostgreSQL/PostgREST tests, never using the application's .env.

Run: D89_RUN_FINANCIAL_INTEGRATION=1 .venv/bin/pytest -q apps/api/tests/
Requires local postgres:17.6-alpine and postgrest/postgrest:v13.0.7 images.
Only uniquely named, disposable containers are created; no production volumes
or networks are used. Auth/Storage schema contracts are minimal test fixtures:
JWT verification, application SQL, migrations and REST RLS run for real, but
GoTrue sign-in and uploading receipt bytes to Storage are not covered here.
"""

import os
import secrets
import subprocess
import time
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import httpx
import jwt
import psycopg
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import app

ROOT = Path(__file__).resolve().parents[3]
MIGRATIONS = ROOT / "supabase/migrations"
REPAIR = MIGRATIONS / "202609270001_expense_insert_security.sql"

BOOTSTRAP = """
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (
  id text primary key, name text, public boolean,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id), name text not null,
  unique(bucket_id, name)
);
alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable
as $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1)-1] $$;
"""


def docker(*args: str) -> str:
    return subprocess.check_output(["docker", *args], text=True, timeout=60).strip()


@pytest.fixture(scope="module")
def isolated_services():
    if os.environ.get("D89_RUN_FINANCIAL_INTEGRATION") != "1":
        pytest.skip("Set D89_RUN_FINANCIAL_INTEGRATION=1 to run disposable Docker services")
    suffix = uuid4().hex[:12]
    pg_name, rest_name = f"d89-security-pg-{suffix}", f"d89-security-rest-{suffix}"
    password, secret = secrets.token_hex(24), secrets.token_hex(32)
    started = []
    try:
        docker(
            "run",
            "--detach",
            "--rm",
            "--pull=never",
            "--name",
            pg_name,
            "--memory=256m",
            "--cpus=0.5",
            "--tmpfs",
            "/var/lib/postgresql/data",
            "--publish",
            "127.0.0.1::5432",
            "--publish",
            "127.0.0.1::3000",
            "--env",
            f"POSTGRES_PASSWORD={password}",
            "postgres:17.6-alpine",
        )
        started.append(pg_name)
        pg_port = docker("port", pg_name, "5432/tcp").rsplit(":", 1)[1]
        rest_port = docker("port", pg_name, "3000/tcp").rsplit(":", 1)[1]
        dsn = f"postgresql://postgres:{password}@127.0.0.1:{pg_port}/postgres"
        for attempt in range(100):
            try:
                with psycopg.connect(dsn, connect_timeout=2):
                    break
            except psycopg.OperationalError:
                if attempt == 99:
                    raise
                time.sleep(0.2)
        with psycopg.connect(dsn, autocommit=True) as connection:
            connection.execute("create role anon nologin")
            connection.execute("create role authenticated nologin")
            connection.execute("create role service_role nologin bypassrls")
        yield {
            "pg_name": pg_name,
            "rest_name": rest_name,
            "password": password,
            "dsn": dsn,
            "rest_url": f"http://127.0.0.1:{rest_port}",
            "secret": secret,
            "started": started,
        }
    finally:
        for name in reversed(started):
            docker("stop", "--time", "2", name)


def one_line(amount: str, description: str = "Integración") -> list[dict[str, str]]:
    """Single-concept expense whose total (IVA incluido) equals `amount`."""
    return [
        {"quantity": "1", "unit": "servicio", "description": description, "unit_price": amount}
    ]


def seed(connection):
    ids = {
        name: uuid4()
        for name in ("admin", "operativo", "outsider", "work", "area", "supplier", "legacy")
    }
    for role in ("admin", "operativo", "outsider"):
        connection.execute("insert into auth.users values (%s)", (ids[role],))
        connection.execute(
            "insert into public.perfil_usuario(id,nombre,rol) values (%s,%s,%s)",
            (ids[role], f"Test {role}", "admin" if role == "admin" else "operativo"),
        )
    connection.execute("insert into public.obra(id,nombre) values (%s,'Test')", (ids["work"],))
    connection.execute(
        "insert into public.usuario_obra(usuario_id,obra_id) values (%s,%s)",
        (ids["operativo"], ids["work"]),
    )
    connection.execute(
        "insert into public.area(id,obra_id,nombre,ruta_normalizada) "
        "values (%s,%s,'Test','{TEST}')",
        (ids["area"], ids["work"]),
    )
    connection.execute(
        "insert into public.catalogo_proveedor(id,nombre) values (%s,'Test')",
        (ids["supplier"],),
    )
    connection.execute(
        "insert into public.obra_proveedor(obra_id,proveedor_id) values (%s,%s)",
        (ids["work"], ids["supplier"]),
    )
    item, subitem = connection.execute(
        "select partida_gasto_id,id from public.catalogo_subpartida_gasto limit 1"
    ).fetchone()
    category = connection.execute(
        "select id from public.catalogo_categoria_gasto limit 1"
    ).fetchone()[0]
    ids.update(item=item, subitem=subitem, category=category)
    header_detail = connection.execute(
        """select exists(select 1 from information_schema.columns
           where table_schema='public' and table_name='gasto' and column_name='subtotal')"""
    ).fetchone()[0]
    if header_detail:
        # Same shape the header-detail migration gives to historical expenses.
        connection.execute(
            """insert into public.gasto
               (id,obra_id,area_id,fecha,concepto,importe,subtotal,iva,iva_desglosado,
                estado,creado_por)
               values (%s,%s,%s,'2026-09-01','Historical validated expense',125,125,0,false,
                       'validado',%s)""",
            (ids["legacy"], ids["work"], ids["area"], ids["admin"]),
        )
        connection.execute(
            """insert into public.gasto_concepto
               (gasto_id,posicion,cantidad,unidad,descripcion,precio_unitario,importe_concepto)
               values (%s,1,1,'servicio','Historical validated expense',125,125)""",
            (ids["legacy"],),
        )
    else:
        # Pre header-detail schema: the migration itself must backfill this row.
        connection.execute(
            """insert into public.gasto
               (id,obra_id,area_id,fecha,concepto,importe,estado,creado_por)
               values (%s,%s,%s,'2026-09-01','Historical validated expense',125,'validado',%s)""",
            (ids["legacy"], ids["work"], ids["area"], ids["admin"]),
        )
    return ids


def policies(connection):
    return connection.execute(
        """select policyname, permissive, roles, cmd, qual, with_check
           from pg_policies where schemaname='public' and tablename='gasto'
           order by policyname"""
    ).fetchall()


@pytest.mark.parametrize("installation", ["fresh", "upgrade"])
def test_financial_security_end_to_end(isolated_services, installation):
    services = isolated_services
    database = f"security_{installation}"
    with psycopg.connect(services["dsn"], autocommit=True) as admin:
        # Only generated test database names are used, never a configured D89 URL.
        admin.execute(
            psycopg.sql.SQL("create database {}").format(psycopg.sql.Identifier(database))
        )
    dsn = services["dsn"].removesuffix("postgres") + database
    secret = services["secret"]
    with psycopg.connect(dsn, autocommit=True) as connection:
        connection.execute(BOOTSTRAP)
        for path in sorted(MIGRATIONS.glob("*.sql")):
            if path == REPAIR:
                before_policies = policies(connection)
                if installation == "upgrade":
                    ids = seed(connection)
                    before_rows = connection.execute(
                        "select * from public.gasto order by id"
                    ).fetchall()
                connection.execute(path.read_text())
                if installation == "upgrade":
                    assert (
                        connection.execute("select * from public.gasto order by id").fetchall()
                        == before_rows
                    )
            else:
                connection.execute(path.read_text())
        connection.execute((ROOT / "supabase/seed.sql").read_text())
        if installation == "upgrade":
            # The header-detail migration backfilled the pre-existing expense.
            assert connection.execute(
                """select g.folio, g.subtotal, g.iva, g.iva_desglosado, c.cantidad, c.unidad,
                          c.descripcion, c.importe_concepto
                   from public.gasto g join public.gasto_concepto c on c.gasto_id = g.id
                   where g.id = %s""",
                (ids["legacy"],),
            ).fetchall() == [
                ("G-00001", Decimal("125.0000"), Decimal("0.0000"), False, Decimal("1.0000"),
                 "servicio", "Historical validated expense", Decimal("125.0000"))
            ]
        # Later hardening only adds restrictive *_solo_backend policies; the rest are unchanged.
        assert [
            p for p in policies(connection) if not p[0].endswith("_solo_backend")
        ] == before_policies
        restriction = next(p for p in policies(connection) if p[0] == "gasto_insert_solo_backend")
        assert restriction[1] == "RESTRICTIVE" and restriction[3] == "INSERT"
        assert set(restriction[2]) == {"anon", "authenticated"} and restriction[5] == "false"
        for role in ("anon", "authenticated"):
            for table in ("gasto", "gasto_concepto", "gasto_comprobante"):
                for privilege in ("INSERT", "UPDATE", "DELETE"):
                    assert not connection.execute(
                        "select has_table_privilege(%s,%s,%s)",
                        (role, f"public.{table}", privilege),
                    ).fetchone()[0], (role, table, privilege)
        if installation == "fresh":
            ids = seed(connection)

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
            f"PGRST_JWT_SECRET={secret}",
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

                def headers(role):
                    return {
                        "Authorization": "Bearer "
                        + jwt.encode(
                            {
                                "sub": str(ids[role]),
                                "role": "authenticated",
                                "aud": "authenticated",
                                "app_metadata": {
                                    "role": "admin" if role == "admin" else "operativo"
                                },
                                "exp": int(time.time()) + 600,
                            },
                            secret,
                            algorithm="HS256",
                        )
                    }

                settings = Settings(_env_file=None, database_url=dsn, jwt_secret=secret)
                previous_overrides = app.dependency_overrides.copy()
                app.dependency_overrides[get_settings] = lambda: settings
                try:
                    with TestClient(app) as api:
                        folios = []
                        for role in ("admin", "operativo"):
                            for state in (None, "pendiente", "validado"):
                                payload = {
                                    "work_id": str(ids["work"]),
                                    "area_id": str(ids["area"]),
                                    "expense_item_id": str(ids["item"]),
                                    "expense_subitem_id": str(ids["subitem"]),
                                    "expense_category_id": str(ids["category"]),
                                    "supplier_id": str(ids["supplier"]),
                                    "spent_on": "2026-09-27",
                                    "concept": "Security integration",
                                    "lines": one_line("100.00"),
                                }
                                if state is not None:
                                    payload["state"] = state
                                response = api.post(
                                    "/api/v1/expenses", json=payload, headers=headers(role)
                                )
                                assert response.status_code == 201, response.text
                                created = response.json()
                                expense_id = created["id"]
                                assert created["state"] == "pendiente"
                                folios.append(created["folio"])
                                # Price 100 includes IVA: 100 / 1.16 = 86.21 + 13.79.
                                assert (created["amount"], created["subtotal"], created["iva"]) == (
                                    "100.0000", "86.2100", "13.7900"
                                )
                                assert [line["amount"] for line in created["lines"]] == ["100.0000"]
                                assert created["receipts"] == [] and created["iva_breakdown"]
                                assert connection.execute(
                                    "select estado,validado_por,validado_en "
                                    "from public.gasto where id=%s",
                                    (expense_id,),
                                ).fetchone() == ("pendiente", None, None)
                                assert (
                                    connection.execute(
                                        "select count(*) from public.audit_log_negocio "
                                        "where entidad_id=%s and accion='crear'",
                                        (expense_id,),
                                    ).fetchone()[0]
                                    == 1
                                )
                        # Quick supplier creation from the expense form (admin only): created and
                        # assigned to the work in one transaction, then usable right away.
                        catalog_url = f"/api/v1/works/{ids['work']}/catalog"
                        assert api.get(catalog_url, headers=headers("operativo")).json()[
                            "permissions"
                        ] == {"can_manage_suppliers": False}
                        assert api.get(catalog_url, headers=headers("admin")).json()[
                            "permissions"
                        ] == {"can_manage_suppliers": True}
                        quick = {"name": "Proveedor imprevisto", "work_id": str(ids["work"])}
                        assert (
                            api.post("/api/v1/suppliers", json=quick, headers=headers("operativo"))
                            .status_code == 403
                        )
                        new_supplier = api.post(
                            "/api/v1/suppliers", json=quick, headers=headers("admin")
                        )
                        assert new_supplier.status_code == 201, new_supplier.text
                        catalog = api.get(catalog_url, headers=headers("operativo")).json()
                        assert new_supplier.json()["id"] in [s["id"] for s in catalog["suppliers"]]
                        with_new_supplier = api.post(
                            "/api/v1/expenses",
                            json={
                                **{k: v for k, v in payload.items() if k != "state"},
                                "supplier_id": new_supplier.json()["id"],
                            },
                            headers=headers("operativo"),
                        )
                        assert with_new_supplier.status_code == 201, with_new_supplier.text
                        folios.append(with_new_supplier.json()["folio"])
                        # Folios are server-generated, unique and consecutive after the legacy one.
                        assert folios == [f"G-{n:05d}" for n in range(2, 9)]
                        assert connection.execute(
                            "select count(*) from public.gasto_concepto where gasto_id = %s",
                            (expense_id,),
                        ).fetchone()[0] == 1
                        # The last loop expense belongs to operativo; receipt metadata is a fixture.
                        review_url = f"/api/v1/expenses/{expense_id}/review"
                        assert (
                            api.post(
                                review_url, json={"action": "validate"}, headers=headers("admin")
                            ).status_code
                            == 422
                        )
                        receipt = f"{ids['work']}/{expense_id}/receipt.pdf"
                        missing = api.patch(
                            f"/api/v1/expenses/{expense_id}/receipt",
                            json={"path": f"{ids['work']}/{expense_id}/never-uploaded.pdf"},
                            headers=headers("operativo"),
                        )
                        assert missing.status_code == 422, missing.text
                        assert missing.json()["detail"] == "El comprobante no existe en Storage"
                        assert connection.execute(
                            "select count(*) from public.gasto_comprobante where gasto_id=%s",
                            (expense_id,),
                        ).fetchone()[0] == 0
                        connection.execute(
                            "insert into storage.objects(bucket_id,name) "
                            "values ('comprobantes',%s)",
                            (receipt,),
                        )
                        cfdi = f"{ids['work']}/{expense_id}/factura-cfdi.xml"
                        connection.execute(
                            "insert into storage.objects(bucket_id,name) "
                            "values ('comprobantes',%s)",
                            (cfdi,),
                        )
                        for path in (receipt, cfdi, receipt):  # the repeated path is idempotent
                            attached = api.patch(
                                f"/api/v1/expenses/{expense_id}/receipt",
                                json={"path": path},
                                headers=headers("operativo"),
                            )
                            assert attached.status_code == 200, attached.text
                        assert [
                            (item["path"], item["kind"]) for item in attached.json()["receipts"]
                        ] == [(receipt, "pdf"), (cfdi, "xml")]
                        detail = api.get(
                            f"/api/v1/expenses/{expense_id}", headers=headers("operativo")
                        )
                        assert detail.status_code == 200 and len(detail.json()["receipts"]) == 2
                        # Read-only display data for the detail view.
                        shown = detail.json()
                        assert shown["supplier_name"] == "Test"
                        assert shown["area_path"] == ["TEST"]
                        assert shown["expense_item"] and shown["expense_subitem"]
                        assert shown["expense_category"] and shown["author"] == "Test operativo"
                        assert shown["created_at"] and shown["budget_item"] is None
                        assert (
                            api.get(
                                f"/api/v1/expenses/{expense_id}", headers=headers("outsider")
                            ).status_code
                            == 403
                        )
                        assert (
                            api.post(
                                review_url,
                                json={"action": "validate"},
                                headers=headers("operativo"),
                            ).status_code
                            == 403
                        )
                        reviewed = api.post(
                            review_url, json={"action": "validate"}, headers=headers("admin")
                        )
                        assert (
                            reviewed.status_code == 200 and reviewed.json()["estado"] == "validado"
                        )
                        # lpad() would truncate here; the folio function must not.
                        connection.execute("select setval('public.gasto_folio_seq', 99999)")
                        big = api.post(
                            "/api/v1/expenses",
                            json={k: v for k, v in payload.items() if k != "state"},
                            headers=headers("admin"),
                        )
                        assert big.status_code == 201 and big.json()["folio"] == "G-100000"
                        assert (
                            connection.execute(
                                "select validado_por from public.gasto where id=%s", (expense_id,)
                            ).fetchone()[0]
                            == ids["admin"]
                        )
                        assert (
                            connection.execute(
                                "select count(*) from public.audit_log_negocio "
                                "where entidad_id=%s and accion='validar'",
                                (expense_id,),
                            ).fetchone()[0]
                            == 1
                        )
                finally:
                    app.dependency_overrides.clear()
                    app.dependency_overrides.update(previous_overrides)

                count = connection.execute("select count(*) from public.gasto").fetchone()[0]
                for role in ("admin", "operativo"):
                    visible = rest.get("/gasto", params={"select": "id"}, headers=headers(role))
                    assert visible.status_code == 200 and len(visible.json()) == count
                invisible = rest.get("/gasto", params={"select": "id"}, headers=headers("outsider"))
                assert invisible.status_code == 200 and invisible.json() == []

                # Check both privilege denial and RLS independently, including admin_all.
                for grant_insert in (False, True):
                    if grant_insert:
                        # The folio default calls nextval(); grant the sequence too so this
                        # branch isolates RLS instead of failing earlier on the sequence.
                        connection.execute(
                            "grant insert on public.gasto to anon, authenticated; "
                            "grant usage on sequence public.gasto_folio_seq to anon, authenticated"
                        )
                    try:
                        for role in ("admin", "operativo", None):
                            response = rest.post(
                                "/gasto",
                                json={
                                    "obra_id": str(ids["work"]),
                                    "area_id": str(ids["area"]),
                                    "fecha": "2026-09-27",
                                    "concepto": "Forbidden REST insert",
                                    "importe": 100,
                                    "estado": "validado",
                                    "creado_por": str(ids[role or "operativo"]),
                                },
                                headers=headers(role) if role else {},
                            )
                            assert response.status_code in (401, 403), response.text
                            assert response.json()["code"] == "42501"
                            if grant_insert:
                                assert "row-level security" in response.json()["message"]
                        assert (
                            connection.execute("select count(*) from public.gasto").fetchone()[0]
                            == count
                        )
                    finally:
                        connection.execute(
                            "revoke insert on public.gasto from anon, authenticated; "
                            "revoke usage on sequence public.gasto_folio_seq "
                            "from anon, authenticated"
                        )

                # Header-detail tables: readable per work access, never writable through REST.
                for table in ("gasto_concepto", "gasto_comprobante"):
                    total_rows = connection.execute(
                        f"select count(*) from public.{table}"
                    ).fetchone()[0]
                    assert total_rows > 0
                    for role in ("admin", "operativo"):
                        seen = rest.get(f"/{table}", params={"select": "id"}, headers=headers(role))
                        assert seen.status_code == 200 and len(seen.json()) == total_rows
                    hidden = rest.get(
                        f"/{table}", params={"select": "id"}, headers=headers("outsider")
                    )
                    assert hidden.status_code == 200 and hidden.json() == []
                    for grant in (False, True):
                        if grant:
                            connection.execute(
                                f"grant insert, update, delete on public.{table} "
                                "to anon, authenticated"
                            )
                        try:
                            for role in ("admin", "operativo"):
                                forged = rest.post(
                                    f"/{table}",
                                    json={"gasto_id": str(ids["legacy"]), "posicion": 9,
                                          "cantidad": 1, "unidad": "x", "descripcion": "x",
                                          "precio_unitario": 1, "importe_concepto": 1}
                                    if table == "gasto_concepto"
                                    else {"gasto_id": str(ids["legacy"]),
                                          "ruta": "forged.pdf", "tipo": "pdf"},
                                    headers=headers(role),
                                )
                                assert forged.status_code in (401, 403), forged.text
                                assert forged.json()["code"] == "42501"
                                removed = rest.delete(
                                    f"/{table}",
                                    params={"gasto_id": f"eq.{ids['legacy']}"},
                                    headers={**headers(role), "Prefer": "return=representation"},
                                )
                                # Without the grant: 42501; with it, the restrictive policy
                                # leaves nothing deletable.
                                assert removed.status_code in (401, 403) or removed.json() == []
                            assert connection.execute(
                                f"select count(*) from public.{table}"
                            ).fetchone()[0] == total_rows
                        finally:
                            connection.execute(
                                f"revoke insert, update, delete on public.{table} "
                                "from anon, authenticated"
                            )

                # Direct REST mutations of expenses are closed: not even the author of a
                # pending row (old gasto_propio_pendiente_update) nor admin (gasto_admin_all).
                own_pending = connection.execute(
                    "select id from public.gasto "
                    "where creado_por=%s and estado='pendiente' limit 1",
                    (ids["operativo"],),
                ).fetchone()[0]
                before = connection.execute(
                    "select concepto, importe, eliminado_en from public.gasto where id=%s",
                    (own_pending,),
                ).fetchone()
                for grant in (False, True):
                    if grant:
                        # Privileges back on: the restrictive policies must still refuse.
                        connection.execute(
                            "grant update, delete on public.gasto to anon, authenticated"
                        )
                    try:
                        for role in ("operativo", "admin"):
                            auth = {**headers(role), "Prefer": "return=representation"}
                            target = {"id": f"eq.{own_pending}"}
                            edited = rest.patch(
                                "/gasto", params=target, json={"importe": 1}, headers=auth
                            )
                            removed = rest.delete("/gasto", params=target, headers=auth)
                            for response in (edited, removed):
                                if grant:
                                    # RLS filters the row out: nothing is changed.
                                    assert response.status_code == 200, response.text
                                    assert response.json() == []
                                else:
                                    assert response.status_code in (401, 403), response.text
                                    assert response.json()["code"] == "42501"
                    finally:
                        connection.execute(
                            "revoke update, delete on public.gasto from anon, authenticated"
                        )
                assert connection.execute(
                    "select concepto, importe, eliminado_en from public.gasto where id=%s",
                    (own_pending,),
                ).fetchone() == before
                assert (
                    connection.execute(
                        "select estado from public.gasto where id=%s", (ids["legacy"],)
                    ).fetchone()[0]
                    == "validado"
                )
        finally:
            docker("stop", "--time", "2", services["rest_name"])
            services["started"].remove(services["rest_name"])
