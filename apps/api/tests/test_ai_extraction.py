"""AI extraction endpoints with a mocked LiteLLM proxy (httpx.MockTransport, no network)."""

import json
from contextlib import contextmanager
from decimal import Decimal
from unittest.mock import MagicMock
from uuid import uuid4

import httpx
import jwt
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import app
from app.services import ai_extraction

PDF = b"%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
CSF_URL = "/api/v1/suppliers/extract-csf"
RECEIPT_URL = "/api/v1/expenses/extract-receipt"


class Proxy:
    """Records requests to the fake LiteLLM proxy and answers with a queued reply."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.reply: httpx.Response | Exception = httpx.Response(500)

    def answer(self, content: object, *, cost: str | None = "0.00042", model: str = "m") -> None:
        text = content if isinstance(content, str) else json.dumps(content)
        body = {
            "model": model,
            "choices": [{"message": {"content": text}}],
            "usage": {"total_tokens": 1234},
        }
        headers = {"x-litellm-response-cost": cost} if cost else {}
        self.reply = httpx.Response(200, json=body, headers=headers)

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(
            {
                "url": str(request.url),
                "auth": request.headers.get("authorization"),
                "body": json.loads(request.content),
            }
        )
        if isinstance(self.reply, Exception):
            raise self.reply
        return self.reply


@pytest.fixture
def settings() -> Settings:
    return Settings(
        _env_file=None,
        jwt_secret="test-secret-with-at-least-32-bytes!!",
        litellm_base_url="http://litellm.test/v1",
        litellm_api_key="sk-extraccion-test",
    )


@pytest.fixture
def proxy(monkeypatch, settings) -> Proxy:
    fake = Proxy()
    monkeypatch.setattr(
        ai_extraction,
        "http_client",
        lambda current: httpx.AsyncClient(
            base_url=current.litellm_base_url, transport=httpx.MockTransport(fake.handler)
        ),
    )
    return fake


@pytest.fixture
def logs(monkeypatch) -> list[dict]:
    """Capture tool_call_log inserts instead of touching a database."""
    rows: list[dict] = []

    def execute(sql, params=None):
        result = MagicMock()
        if "insert into public.tool_call_log" in sql:
            user_id, tool, parameters, outcome, model, tokens, cost = params
            row_id = uuid4()
            rows.append(
                {
                    "id": row_id,
                    "usuario_id": user_id,
                    "tool_name": tool,
                    "parametros": parameters.obj,
                    "resultado": outcome,
                    "modelo": model,
                    "tokens": tokens,
                    "costo": cost,
                }
            )
            result.fetchone.return_value = {"id": row_id}
        return result

    connection = MagicMock()
    connection.execute.side_effect = execute

    @contextmanager
    def fake_transaction(current):
        yield connection

    monkeypatch.setattr(ai_extraction, "transaction", fake_transaction)
    monkeypatch.setattr(ai_extraction, "require_active_profile", lambda *args: None)
    return rows


@pytest.fixture
def client(settings):
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def auth(settings: Settings, role: str = "admin") -> dict[str, str]:
    token = jwt.encode(
        {"sub": str(uuid4()), "aud": "authenticated", "app_metadata": {"role": role}},
        settings.jwt_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def upload(content: bytes, mime: str, name: str = "doc") -> dict:
    return {"file": (name, content, mime)}


CSF_OK = {
    "rfc": "abc-010203-xy9",
    "razon_social": "Concretos Toluca SA de CV",
    "regimen_fiscal": "601 - General de Ley Personas Morales",
    "codigo_postal": "50000",
    "requiere_validacion_humana": False,
    "motivos_revision": [],
}


def receipt(total, concepts, flagged=False, reasons=None) -> dict:
    return {
        "total_detectado": total,
        "conceptos": [
            {"cantidad": q, "precio_unitario": p, "descripcion": d} for q, p, d in concepts
        ],
        "requiere_validacion_humana": flagged,
        "motivos_revision": reasons or [],
    }


def assert_strict_request(request: dict, alias: str) -> dict:
    body = request["body"]
    assert request["url"] == "http://litellm.test/v1/chat/completions"
    assert request["auth"] == "Bearer sk-extraccion-test"
    assert body["model"] == alias
    assert body["temperature"] == 0
    assert body["messages"][0]["role"] == "system"
    fmt = body["response_format"]
    assert fmt["type"] == "json_schema" and fmt["json_schema"]["strict"] is True
    schema = fmt["json_schema"]["schema"]
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(schema["properties"])
    assert "$defs" not in json.dumps(schema) and "$ref" not in json.dumps(schema)
    return body["messages"][1]["content"][1]


def test_csf_extraction_sends_pdf_with_strict_schema_and_logs_without_content(
    client, settings, proxy, logs
):
    proxy.answer(CSF_OK, model="gemini-3.5-flash-lite")
    response = client.post(CSF_URL, files=upload(PDF, "application/pdf"), headers=auth(settings))
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["extraction"] == {**CSF_OK, "rfc": "ABC010203XY9"}
    assert data["model"] == "gemini-3.5-flash-lite"
    part = assert_strict_request(proxy.requests[0], "d89-documentos")
    assert part["type"] == "file"
    assert part["file"]["file_data"].startswith("data:application/pdf;base64,")
    schema = proxy.requests[0]["body"]["response_format"]["json_schema"]["schema"]
    assert set(schema["properties"]) >= {"rfc", "razon_social", "regimen_fiscal", "codigo_postal"}
    [log] = logs
    assert str(log["id"]) == data["tool_call_log_id"]
    assert (log["tool_name"], log["resultado"]) == ("extraer_csf", "ejecutado")
    assert log["modelo"] == "gemini-3.5-flash-lite" and log["tokens"] == 1234
    assert log["costo"] == Decimal("0.00042")
    assert set(log["parametros"]) == {
        "mime", "bytes", "sha256", "alias", "requiere_validacion_humana"
    }
    assert "base64" not in json.dumps(log["parametros"])


def test_csf_missing_or_malformed_postal_code_requires_human_review(client, settings, proxy, logs):
    proxy.answer({**CSF_OK, "codigo_postal": "500", "regimen_fiscal": None})
    data = client.post(
        CSF_URL, files=upload(PDF, "application/pdf"), headers=auth(settings)
    ).json()["extraction"]
    assert data["requiere_validacion_humana"] is True
    assert any("regimen_fiscal" in reason for reason in data["motivos_revision"])
    assert any("5 dígitos" in reason for reason in data["motivos_revision"])


@pytest.mark.parametrize(
    "content",
    ["no es json", json.dumps({**CSF_OK, "extra": 1}), json.dumps({**CSF_OK, "rfc": "X1"})],
)
def test_csf_invalid_model_output_is_rejected_and_logged(client, settings, proxy, logs, content):
    proxy.answer(content)
    response = client.post(CSF_URL, files=upload(PDF, "application/pdf"), headers=auth(settings))
    assert response.status_code == 502
    assert response.json()["detail"] == "La IA devolvió datos no válidos"
    [log] = logs
    assert log["resultado"] == "error" and log["parametros"]["error"] == "invalid"
    assert response.headers["X-D89-Tool-Call"] == str(log["id"])


def test_csf_is_admin_only(client, settings, proxy, logs):
    response = client.post(
        CSF_URL, files=upload(PDF, "application/pdf"), headers=auth(settings, "operativo")
    )
    assert response.status_code == 403
    assert proxy.requests == [] and logs == []


def test_receipt_extraction_sends_image_and_keeps_consistent_totals(client, settings, proxy, logs):
    proxy.answer(receipt(1250.5, [(10, 100, "Cemento gris 50 kg"), (1, 250.5, "Flete")]))
    response = client.post(
        RECEIPT_URL, files=upload(PNG, "image/png"), headers=auth(settings, "operativo")
    )
    assert response.status_code == 200, response.text
    data = response.json()["extraction"]
    part = assert_strict_request(proxy.requests[0], "d89-vision")
    assert part["type"] == "image_url"
    assert part["image_url"]["url"].startswith("data:image/png;base64,")
    assert data["requiere_validacion_humana"] is False
    assert Decimal(data["total_detectado"]) == Decimal("1250.5")
    assert Decimal(data["suma_conceptos"]) == Decimal("1250.50")
    assert [Decimal(item["cantidad"]) for item in data["conceptos"]] == [10, 1]
    assert logs[0]["tool_name"] == "extraer_comprobante"
    assert logs[0]["parametros"]["requiere_validacion_humana"] is False


@pytest.mark.parametrize(
    ("model_output", "reason"),
    [
        (receipt(900, [(10, 100, "Cemento")]), "no coincide con el total"),
        (receipt(998.99, [(10, 100, "Cemento")]), "no coincide con el total"),
        (receipt(None, [(1, 50, "Clavos")]), "No se detectó el total"),
        (receipt(100, []), "No se detectaron conceptos"),
        (receipt(100, [(None, 100, "Arena")]), "incompletos o ilegibles"),
        (receipt(100, [(1, 100, "   ")]), "incompletos o ilegibles"),
        (receipt(-100, [(-1, 100, "Devolución")]), "negativos"),
    ],
)
def test_receipt_server_forces_human_review_even_if_model_does_not(
    client, settings, proxy, logs, model_output, reason
):
    assert model_output["requiere_validacion_humana"] is False
    proxy.answer(model_output)
    data = client.post(
        RECEIPT_URL, files=upload(PNG, "image/png"), headers=auth(settings)
    ).json()["extraction"]
    assert data["requiere_validacion_humana"] is True
    assert any(reason in item for item in data["motivos_revision"])
    assert logs[0]["parametros"]["requiere_validacion_humana"] is True


def test_receipt_model_flag_and_reasons_are_preserved(client, settings, proxy, logs):
    proxy.answer(receipt(100, [(1, 100, "Varilla")], True, ["Caligrafía dudosa en el total"]))
    data = client.post(
        RECEIPT_URL, files=upload(PNG, "image/png"), headers=auth(settings)
    ).json()["extraction"]
    assert data["requiere_validacion_humana"] is True
    assert data["motivos_revision"] == ["Caligrafía dudosa en el total"]


def test_receipt_tolerates_rounding_within_one_peso(client, settings, proxy, logs):
    proxy.answer(receipt(333.33, [(3, 111.1, "Tubo PVC")]))
    data = client.post(
        RECEIPT_URL, files=upload(PNG, "image/png"), headers=auth(settings)
    ).json()["extraction"]
    assert data["requiere_validacion_humana"] is False


@pytest.mark.parametrize(
    ("url", "content", "mime"),
    [
        (CSF_URL, PNG, "application/pdf"),  # PNG bytes disguised as PDF
        (CSF_URL, PDF, "image/png"),  # declared type does not match magic bytes
        (RECEIPT_URL, PDF, "application/pdf"),  # receipts accept images only
        (RECEIPT_URL, b"GIF89a....", "image/gif"),
        (RECEIPT_URL, b"not an image", "image/jpeg"),
    ],
)
def test_invalid_file_types_are_rejected_before_calling_ai(
    client, settings, proxy, logs, url, content, mime
):
    response = client.post(url, files=upload(content, mime), headers=auth(settings))
    assert response.status_code == 415
    assert proxy.requests == [] and logs == []


def test_oversized_file_is_rejected_before_calling_ai(client, settings, proxy, logs):
    settings.ai_max_upload_bytes = 64
    response = client.post(
        RECEIPT_URL, files=upload(PNG + b"\x00" * 64, "image/png"), headers=auth(settings)
    )
    assert response.status_code == 413
    assert proxy.requests == [] and logs == []


def test_empty_file_is_rejected(client, settings, proxy, logs):
    response = client.post(RECEIPT_URL, files=upload(b"", "image/png"), headers=auth(settings))
    assert response.status_code == 422
    assert proxy.requests == []


@pytest.mark.parametrize(
    ("reply", "status_code", "kind"),
    [
        (httpx.ConnectError("proxy caído"), 503, "unavailable"),
        (httpx.ReadTimeout("timeout"), 503, "unavailable"),
        (httpx.Response(429, json={"error": "rate limited"}), 429, "budget"),
        (
            httpx.Response(400, json={"error": {"message": "Budget has been exceeded! Current"}}),
            429,
            "budget",
        ),
        (httpx.Response(500, json={"error": "boom"}), 502, "upstream"),
        (httpx.Response(200, json={"choices": []}), 502, "invalid"),
    ],
)
def test_gateway_failures_map_to_clear_errors_and_are_logged(
    client, settings, proxy, logs, reply, status_code, kind
):
    proxy.reply = reply
    response = client.post(RECEIPT_URL, files=upload(PNG, "image/png"), headers=auth(settings))
    assert response.status_code == status_code
    [log] = logs
    assert log["resultado"] == "error" and log["parametros"]["error"] == kind


def test_missing_virtual_key_fails_closed_without_calling_proxy(client, settings, proxy, logs):
    settings.litellm_api_key = ""
    response = client.post(CSF_URL, files=upload(PDF, "application/pdf"), headers=auth(settings))
    assert response.status_code == 503
    assert response.json()["detail"] == "Servicio de IA no configurado"
    assert proxy.requests == []
    assert logs[0]["parametros"]["error"] == "sin_clave"


def test_extraction_requires_session(client, proxy, logs):
    response = client.post(RECEIPT_URL, files=upload(PNG, "image/png"))
    assert response.status_code == 401
    assert proxy.requests == []


def test_aliases_come_from_settings(client, settings, proxy, logs):
    settings.ai_receipt_model = "d89-vision-alternativa"
    proxy.answer(receipt(100, [(1, 100, "Arena")]))
    client.post(RECEIPT_URL, files=upload(PNG, "image/png"), headers=auth(settings))
    assert proxy.requests[0]["body"]["model"] == "d89-vision-alternativa"
