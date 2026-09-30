from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]


def load_env() -> dict[str, str]:
    return dict(
        line.split("=", 1)
        for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#") and "=" in line
    )


def main() -> None:
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
        works = client.get("/api/v1/works", headers=auth)
        works.raise_for_status()
        work_id = works.json()[0]["id"]
        expenses = client.get("/api/v1/expenses", headers=auth, params={"work_id": work_id})
        expenses.raise_for_status()
        expense_id = expenses.json()[0]["id"]
        income = client.post(
            "/api/v1/incomes",
            headers=auth,
            json={
                "work_id": work_id,
                "concept": "Anticipo de validación staging",
                "estimated_date": "2026-08-30",
                "actual_date": "2026-08-30",
                "amount": "75000.00",
                "state": "cobrado",
            },
        )
        income.raise_for_status()
        subcontract = client.post(
            "/api/v1/subcontracts",
            headers=auth,
            json={
                "work_id": work_id,
                "subcontractor": "Contratista de validación",
                "concept": "Instalación de prueba staging",
                "scope": "Evidencia integral de fase 4",
                "contracted_amount": "45000.00",
            },
        )
        subcontract.raise_for_status()
        payment = client.post(
            f"/api/v1/subcontracts/{subcontract.json()['id']}/payments",
            headers=auth,
            json={
                "spent_on": "2026-08-30",
                "amount": "18450.00",
                "linked_expense_id": expense_id,
            },
        )
        payment.raise_for_status()
        incomes = client.get("/api/v1/incomes", headers=auth, params={"work_id": work_id})
        subcontracts = client.get(
            "/api/v1/subcontracts", headers=auth, params={"work_id": work_id}
        )
        incomes.raise_for_status()
        subcontracts.raise_for_status()
        assert any(row["id"] == income.json()["id"] for row in incomes.json())
        assert any(row["id"] == subcontract.json()["id"] for row in subcontracts.json())
    print("Fase 4 live aprobada: ingreso, subcontrato y pago vinculado")


if __name__ == "__main__":
    main()
