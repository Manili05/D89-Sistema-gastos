import argparse
from pathlib import Path
from uuid import uuid4

import httpx

ROOT = Path(__file__).resolve().parents[2]


def load_env() -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    )


def cleanup_supplier(client: httpx.Client, service_key: str, supplier_id: str) -> None:
    headers = {"Authorization": f"Bearer {service_key}", "apikey": service_key}
    for table in ("evaluacion_proveedor", "obra_proveedor", "proveedor_especialidad"):
        response = client.delete(
            f"/rest/v1/{table}",
            headers=headers,
            params={"proveedor_id": f"eq.{supplier_id}"},
        )
        response.raise_for_status()
    response = client.delete(
        "/rest/v1/catalogo_proveedor",
        headers=headers,
        params={"id": f"eq.{supplier_id}"},
    )
    response.raise_for_status()


def verify_crud(
    client: httpx.Client,
    auth: dict[str, str],
    service_key: str,
    work_id: str,
    specialty_id: str,
) -> None:
    marker = uuid4().hex[:10]
    created = client.post(
        "/api/v1/suppliers",
        headers=auth,
        json={"name": f"Proveedor QA {marker}", "specialty_ids": []},
    )
    created.raise_for_status()
    supplier_id = created.json()["id"]
    try:
        updated = client.patch(
            f"/api/v1/suppliers/{supplier_id}",
            headers=auth,
            json={
                "name": f"Proveedor QA {marker}",
                "legal_name": "Directorio QA SA de CV",
                "tax_id": "DSR260904AB1",
                "contact_name": "Contacto QA",
                "phone": "7220000000",
                "whatsapp": "527220000000",
                "email": f"qa-{marker}@example.com",
                "address": "Dirección temporal",
                "coverage": "Toluca",
                "notes": "Registro temporal de verificación",
                "specialty_ids": [specialty_id],
            },
        )
        updated.raise_for_status()

        assignment = client.put(
            f"/api/v1/suppliers/{supplier_id}/works/{work_id}",
            headers=auth,
            json={"notes": "Prueba temporal"},
        )
        assignment.raise_for_status()

        evaluation_payload = {
            "work_id": work_id,
            "expense_id": None,
            "work_description": "Servicio temporal de verificación",
            "service_date": "2026-09-04",
            "quality": 5,
            "timeliness": 4,
            "value": 3,
            "communication": 5,
            "safety": 4,
            "comment": "Evaluación temporal",
        }
        evaluation = client.post(
            f"/api/v1/suppliers/{supplier_id}/evaluations",
            headers=auth,
            json=evaluation_payload,
        )
        evaluation.raise_for_status()
        assert float(evaluation.json()["calificacion"]) == 4.2
        evaluation_id = evaluation.json()["id"]

        edited = client.patch(
            f"/api/v1/suppliers/{supplier_id}/evaluations/{evaluation_id}",
            headers=auth,
            json={**evaluation_payload, "quality": 4},
        )
        edited.raise_for_status()
        assert float(edited.json()["calificacion"]) == 4.0

        voided = client.request(
            "DELETE",
            f"/api/v1/suppliers/{supplier_id}/evaluations/{evaluation_id}",
            headers=auth,
            json={"reason": "Limpieza de verificación"},
        )
        voided.raise_for_status()
        unassigned = client.delete(
            f"/api/v1/suppliers/{supplier_id}/works/{work_id}", headers=auth
        )
        unassigned.raise_for_status()
        archived = client.request(
            "DELETE",
            f"/api/v1/suppliers/{supplier_id}",
            headers=auth,
            json={"reason": "Limpieza de verificación"},
        )
        archived.raise_for_status()
        restored = client.post(f"/api/v1/suppliers/{supplier_id}/restore", headers=auth)
        restored.raise_for_status()
    finally:
        cleanup_supplier(client, service_key, supplier_id)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Verifica el directorio de proveedores activo"
    )
    parser.add_argument(
        "--crud", action="store_true", help="ejecuta un CRUD temporal y lo limpia"
    )
    args = parser.parse_args()
    env = load_env()
    with httpx.Client(base_url="http://127.0.0.1:3089", timeout=30) as client:
        session = client.post(
            "/auth/v1/token?grant_type=password",
            headers={"apikey": env["ANON_KEY"]},
            json={
                "email": env["STAGING_ADMIN_EMAIL"],
                "password": env["STAGING_ADMIN_PASSWORD"],
            },
        )
        session.raise_for_status()
        auth = {"Authorization": f"Bearer {session.json()['access_token']}"}

        specialties = client.get("/api/v1/supplier-specialties", headers=auth)
        specialties.raise_for_status()
        assert len(specialties.json()) >= 10

        suppliers = client.get("/api/v1/suppliers", headers=auth)
        suppliers.raise_for_status()
        directory = suppliers.json()
        assert directory["permissions"]["can_manage"] is True
        assert directory["total"] >= 1

        supplier = directory["items"][0]
        detail = client.get(f"/api/v1/suppliers/{supplier['id']}", headers=auth)
        detail.raise_for_status()
        assert detail.json()["permissions"]["can_manage"] is True

        analytics = client.get("/api/v1/suppliers/analytics", headers=auth)
        analytics.raise_for_status()
        assert analytics.json()["summary"]["active_suppliers"] >= 1

        active_assignments = [
            assignment
            for assignment in detail.json()["assignments"]
            if assignment["activo"]
        ]
        assert active_assignments
        work_id = active_assignments[0]["obra_id"]
        catalog = client.get(f"/api/v1/works/{work_id}/catalog", headers=auth)
        catalog.raise_for_status()
        assert supplier["id"] in {item["id"] for item in catalog.json()["suppliers"]}
        all_suppliers = client.get(
            "/api/v1/suppliers", headers=auth, params={"include_archived": "true"}
        )
        all_suppliers.raise_for_status()

        if args.crud:
            verify_crud(
                client,
                auth,
                env["SERVICE_ROLE_KEY"],
                work_id,
                specialties.json()[0]["id"],
            )

    print(
        "Directorio live aprobado: lectura, métricas, detalle, especialidades "
        "y proveedor asignado al catálogo de gastos"
        + ("; CRUD temporal aprobado y limpiado" if args.crud else "")
    )


if __name__ == "__main__":
    main()
