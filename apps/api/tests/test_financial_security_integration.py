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
        assert [
            p for p in policies(connection) if p[0] != "gasto_insert_solo_backend"
        ] == before_policies
        restriction = next(p for p in policies(connection) if p[0] == "gasto_insert_solo_backend")
        assert restriction[1] == "RESTRICTIVE" and restriction[3] == "INSERT"
        assert set(restriction[2]) == {"anon", "authenticated"} and restriction[5] == "false"
        for role in ("anon", "authenticated"):
            assert not connection.execute(
                "select has_table_privilege(%s,'public.gasto','INSERT')",
                (role,),
            ).fetchone()[0]
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
                                    "amount": "100.00",
                                }
                                if state is not None:
                                    payload["state"] = state
                                response = api.post(
                                    "/api/v1/expenses", json=payload, headers=headers(role)
                                )
                                assert response.status_code == 201, response.text
                                expense_id = response.json()["id"]
                                assert response.json()["estado"] == "pendiente"
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
                        # The last expense belongs to operativo; receipt metadata is a fixture.
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
                            "select comprobante_path from public.gasto where id=%s",
                            (expense_id,),
                        ).fetchone() == (None,)
                        connection.execute(
                            "insert into storage.objects(bucket_id,name) "
                            "values ('comprobantes',%s)",
                            (receipt,),
                        )
                        assert (
                            api.patch(
                                f"/api/v1/expenses/{expense_id}/receipt",
                                json={"path": receipt},
                                headers=headers("operativo"),
                            ).status_code
                            == 200
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
                        connection.execute("grant insert on public.gasto to anon, authenticated")
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
                        connection.execute("revoke insert on public.gasto from anon, authenticated")

                # Existing UPDATE permission/policy still works on the author's pending row.
                own_pending = connection.execute(
                    "select id from public.gasto "
                    "where creado_por=%s and estado='pendiente' limit 1",
                    (ids["operativo"],),
                ).fetchone()[0]
                edited = rest.patch(
                    "/gasto",
                    params={"id": f"eq.{own_pending}"},
                    json={"concepto": "Existing update preserved"},
                    headers={**headers("operativo"), "Prefer": "return=representation"},
                )
                assert edited.status_code == 200 and len(edited.json()) == 1
                assert edited.json()[0]["concepto"] == "Existing update preserved"
                assert (
                    connection.execute(
                        "select estado from public.gasto where id=%s", (ids["legacy"],)
                    ).fetchone()[0]
                    == "validado"
                )
        finally:
            docker("stop", "--time", "2", services["rest_name"])
            services["started"].remove(services["rest_name"])
