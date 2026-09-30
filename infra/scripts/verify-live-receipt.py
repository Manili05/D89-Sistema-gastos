import base64
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


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
        token = session.json()["access_token"]
        auth = {"Authorization": f"Bearer {token}"}
        works = client.get("/api/v1/works", headers=auth)
        works.raise_for_status()
        work_id = works.json()[0]["id"]
        expenses = client.get("/api/v1/expenses", headers=auth, params={"work_id": work_id})
        expenses.raise_for_status()
        expense_id = expenses.json()[0]["id"]
        path = f"{work_id}/{expense_id}/live-evidence.png"
        uploaded = client.post(
            f"/storage/v1/object/comprobantes/{path}",
            headers={
                **auth,
                "apikey": env["ANON_KEY"],
                "Content-Type": "image/png",
                "x-upsert": "true",
            },
            content=PNG,
        )
        uploaded.raise_for_status()
        attached = client.patch(
            f"/api/v1/expenses/{expense_id}/receipt",
            headers=auth,
            json={"path": path},
        )
        attached.raise_for_status()
        assert attached.json()["comprobante_path"] == path
    print("Comprobante privado live aprobado: Storage + vínculo de gasto")


if __name__ == "__main__":
    main()
