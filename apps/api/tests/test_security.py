import time
from uuid import uuid4

import jwt
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.security import sign_hmac
from app.main import app

client = TestClient(app)


def signed_headers(body: bytes, nonce: str | None = None) -> dict[str, str]:
    settings = get_settings()
    timestamp = str(int(time.time()))
    nonce = nonce or str(uuid4())
    signature = sign_hmac(
        settings.hermes_hmac_secret,
        "POST",
        "/api/v1/hermes/hmac-probe",
        timestamp,
        nonce,
        body,
    )
    return {
        "X-D89-Key-Id": settings.hermes_hmac_key_id,
        "X-D89-Timestamp": timestamp,
        "X-D89-Nonce": nonce,
        "X-D89-Signature": signature,
        "Content-Type": "application/json",
    }


def test_hmac_accepts_valid_signature_and_rejects_replay() -> None:
    body = b'{"ping":"pong"}'
    headers = signed_headers(body)

    response = client.post("/api/v1/hermes/hmac-probe", content=body, headers=headers)
    replay = client.post("/api/v1/hermes/hmac-probe", content=body, headers=headers)

    assert response.status_code == 200
    assert response.json() == {"status": "verified"}
    assert replay.status_code == 409


def test_hmac_rejects_modified_body() -> None:
    headers = signed_headers(b'{"amount":100}')
    response = client.post(
        "/api/v1/hermes/hmac-probe",
        content=b'{"amount":1000}',
        headers=headers,
    )
    assert response.status_code == 401


def test_supabase_style_token_role_comes_from_app_metadata() -> None:
    settings = get_settings()
    token = jwt.encode(
        {
            "sub": str(uuid4()),
            "aud": "authenticated",
            "app_metadata": {"role": "admin"},
            "user_metadata": {"role": "operativo"},
        },
        settings.jwt_secret,
        algorithm="HS256",
    )
    response = client.post(
        "/api/v1/neodata/preview",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 422


def test_openapi_is_namespaced() -> None:
    assert client.get("/openapi.json").status_code == 404
    schema = client.get("/api/v1/openapi.json")
    assert schema.status_code == 200
    assert schema.json()["info"]["title"] == "D89 Sistema de Gastos API"
