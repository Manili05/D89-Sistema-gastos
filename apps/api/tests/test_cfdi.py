"""CFDI XML reader: parsing, cross-checks, safe XML handling and exact expense mapping."""

import random
from contextlib import contextmanager
from decimal import ROUND_HALF_UP, Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import jwt
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings, get_settings
from app.main import app
from app.services import cfdi as cfdi_module
from app.services.cfdi import CfdiError, map_concept, parse_cfdi
from app.services.expense_totals import compute_totals, line_amount

CFDI4 = "http://www.sat.gob.mx/cfd/4"
CFDI3 = "http://www.sat.gob.mx/cfd/3"
TFD = "http://www.sat.gob.mx/TimbreFiscalDigital"
UUID_SAT = "6F1A2B3C-4D5E-4F60-8A9B-0C1D2E3F4A5B"


def money(value: Decimal) -> Decimal:
    return value.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def concept_xml(
    cantidad="10", valor="100", unidad_clave="H87", unidad=None, descripcion="Cemento gris",
    descuento=None, traslados=(("002", "Tasa", "0.160000"),), importe=None,
):
    importe = Decimal(importe) if importe is not None else Decimal(cantidad) * Decimal(valor)
    base = importe - Decimal(descuento or 0)
    taxes = ""
    for impuesto, factor, tasa in traslados:
        if factor == "Exento":
            taxes += f'<cfdi:Traslado Base="{base}" Impuesto="{impuesto}" TipoFactor="Exento"/>'
        else:
            taxes += (
                f'<cfdi:Traslado Base="{base}" Impuesto="{impuesto}" TipoFactor="{factor}" '
                f'TasaOCuota="{tasa}" '
                f'Importe="{(base * Decimal(tasa)).quantize(Decimal("0.000001"))}"/>'
            )
    attrs = [
        'ClaveProdServ="30111601"', f'Cantidad="{cantidad}"', f'ClaveUnidad="{unidad_clave}"',
        f'Descripcion="{descripcion}"', f'ValorUnitario="{valor}"', f'Importe="{importe}"',
        'ObjetoImp="02"',
    ]
    if unidad:
        attrs.append(f'Unidad="{unidad}"')
    if descuento:
        attrs.append(f'Descuento="{descuento}"')
    impuestos = f"<cfdi:Impuestos><cfdi:Traslados>{taxes}</cfdi:Traslados></cfdi:Impuestos>"
    return f"<cfdi:Concepto {' '.join(attrs)}>{impuestos if traslados else ''}</cfdi:Concepto>", (
        importe, Decimal(descuento or 0),
        sum((base * Decimal(t)).quantize(Decimal("0.000001")) for _, f, t in traslados
            if f != "Exento"),
    )


def invoice(
    concepts=None, namespace=CFDI4, moneda="MXN", tipo="I", timbre=True, serie="A",
    folio="123", total=None, retenidos=None, emisor_rfc="CPR990101AB1",
):
    concepts = concepts or [concept_xml(), concept_xml("1", "250.50", descripcion="Flete")]
    subtotal = sum(c[1][0] for c in concepts)
    descuento = sum(c[1][1] for c in concepts)
    impuestos = sum(c[1][2] for c in concepts)
    total = total if total is not None else subtotal - descuento + impuestos - Decimal(
        retenidos or 0
    )
    global_taxes = (
        f'<cfdi:Impuestos TotalImpuestosRetenidos="{retenidos}"/>' if retenidos else ""
    )
    complemento = (
        f'<cfdi:Complemento><tfd:TimbreFiscalDigital xmlns:tfd="{TFD}" UUID="{UUID_SAT}"/>'
        "</cfdi:Complemento>" if timbre else ""
    )
    serie_attr = f'Serie="{serie}" ' if serie else ""
    folio_attr = f'Folio="{folio}" ' if folio else ""
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<cfdi:Comprobante xmlns:cfdi="{namespace}" Version="4.0" {serie_attr}{folio_attr}'
        f'Fecha="2026-09-20T10:00:00" SubTotal="{subtotal}" '
        f'{f"Descuento={chr(34)}{descuento}{chr(34)} " if descuento else ""}'
        f'Moneda="{moneda}" Total="{total}" TipoDeComprobante="{tipo}">'
        f'<cfdi:Emisor Rfc="{emisor_rfc}" Nombre="CONCRETOS DE PRUEBA" RegimenFiscal="601"/>'
        f'<cfdi:Receptor Rfc="GOVS800101AB1" Nombre="SERGIO GOMEZ"/>'
        f"<cfdi:Conceptos>{''.join(c[0] for c in concepts)}</cfdi:Conceptos>"
        f"{global_taxes}{complemento}</cfdi:Comprobante>"
    ).encode()


def test_parses_cfdi_4_issuer_concepts_taxes_and_uuid():
    parsed = parse_cfdi(invoice())
    assert (parsed.version, parsed.uuid, parsed.serie, parsed.folio) == (
        "4.0", UUID_SAT, "A", "123"
    )
    assert (parsed.emisor_rfc, parsed.emisor_nombre, parsed.emisor_regimen) == (
        "CPR990101AB1", "CONCRETOS DE PRUEBA", "601"
    )
    assert [(c.cantidad, c.clave_unidad, c.descripcion) for c in parsed.conceptos] == [
        (Decimal("10"), "H87", "Cemento gris"), (Decimal("1"), "H87", "Flete"),
    ]
    assert parsed.subtotal == Decimal("1250.50")
    assert money(parsed.iva_trasladado) == Decimal("200.08")
    assert parsed.total == parsed.subtotal + parsed.iva_trasladado
    assert parsed.advertencias == []


def test_cfdi_3_3_namespace_is_supported():
    assert parse_cfdi(invoice(namespace=CFDI3)).version == "3.3"


def test_exempt_and_ieps_taxes_are_separated_from_iva():
    parsed = parse_cfdi(invoice([
        concept_xml("1", "100", descripcion="Libro", traslados=(("002", "Exento", ""),)),
        concept_xml("1", "100", descripcion="Refresco",
                    traslados=(("003", "Tasa", "0.080000"), ("002", "Tasa", "0.160000"))),
    ]))
    exempt, ieps = parsed.conceptos
    assert (exempt.iva_trasladado, exempt.otros_trasladados) == (0, 0)
    assert (money(ieps.iva_trasladado), money(ieps.otros_trasladados)) == (
        Decimal("16.00"), Decimal("8.00")
    )
    assert parsed.advertencias == []


@pytest.mark.parametrize(
    ("kwargs", "warning"),
    [
        ({"moneda": "USD"}, "moneda del CFDI es USD"),
        ({"tipo": "E"}, "nota de crédito"),
        ({"timbre": False}, "no es un CFDI timbrado"),
        ({"total": Decimal("9999")}, "no coincide con el Total"),
        ({"retenidos": Decimal("25.00")}, "retenciones"),
    ],
)
def test_suspicious_invoices_produce_warnings_not_silent_fixes(kwargs, warning):
    parsed = parse_cfdi(invoice(**kwargs))
    assert any(warning in note for note in parsed.advertencias), parsed.advertencias


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (b'<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]><a>&lol;</a>', "DTD"),
        (b'<!ENTITY x SYSTEM "file:///etc/passwd">', "DTD"),
        (b"<cfdi:Comprobante", "no es un XML"),
        (b'<Factura xmlns="urn:otra"/>', "no es un CFDI"),
        (invoice(emisor_rfc=""), "RFC del emisor"),
        (invoice(concepts=[concept_xml(cantidad="0")]), "inválidos"),
        (invoice(concepts=[concept_xml(valor="abc", importe="1")]), "no es numérico"),
    ],
)
def test_invalid_or_unsafe_xml_is_rejected(content, message):
    with pytest.raises(CfdiError, match=message):
        parse_cfdi(content)


def test_invoice_without_concepts_is_rejected():
    xml = invoice().replace(
        invoice().split(b"<cfdi:Conceptos>")[1].split(b"</cfdi:Conceptos>")[0], b""
    )
    with pytest.raises(CfdiError, match="no contiene conceptos"):
        parse_cfdi(xml)


def test_mapping_includes_taxes_and_the_backend_accepts_the_exact_total():
    parsed = parse_cfdi(invoice())
    lines = [map_concept(c) for c in parsed.conceptos]
    assert [(line.quantity, line.unit, line.amount) for line in lines] == [
        (Decimal("10.0000"), "pieza", Decimal("1160.00")),
        (Decimal("1.0000"), "pieza", Decimal("290.58")),
    ]
    totals = compute_totals(lines, money(parsed.iva_trasladado))
    assert totals.amount == parsed.total == Decimal("1450.58")
    assert totals.iva == Decimal("200.08") and totals.subtotal == parsed.subtotal


def test_quantities_with_more_than_4_decimals_are_kept_in_the_description():
    parsed = parse_cfdi(invoice([concept_xml("1.234567", "10", importe="12.34567")]))
    [line] = [map_concept(c) for c in parsed.conceptos]
    assert line.quantity == 1 and line.description.startswith("1.234567 × ")
    assert line.amount == money(parsed.conceptos[0].total_con_impuestos)


def test_random_invoices_always_map_to_lines_that_sum_to_the_cfdi_exactly():
    rng = random.Random(89)
    for _ in range(400):
        concepts = []
        for _ in range(rng.randint(1, 30)):
            cantidad = Decimal(rng.randint(1, 50000)) / Decimal(10 ** rng.randint(0, 3))
            valor = Decimal(rng.randint(1, 5_000_000)) / Decimal(10 ** rng.randint(0, 4))
            descuento = money(cantidad * valor * Decimal(rng.choice([0, 0, 0.05, 0.1])))
            concepts.append(concept_xml(str(cantidad), str(valor), descuento=str(descuento)
                                        if descuento else None))
        parsed = parse_cfdi(invoice(concepts))
        lines = [map_concept(c) for c in parsed.conceptos]
        for concept, mapped in zip(parsed.conceptos, lines, strict=True):
            # What the form sends is exactly what the backend will compute.
            assert line_amount(mapped) == mapped.amount == money(concept.total_con_impuestos)
            assert mapped.discount >= 0 and mapped.unit_price >= 0
        # Per-concept rounding may exceed the global 16 % by cents: still accepted.
        totals = compute_totals(lines, money(parsed.iva_trasladado))
        assert totals.amount == sum(money(c.total_con_impuestos) for c in parsed.conceptos)
        assert abs(totals.amount - parsed.total) <= Decimal("0.01") * len(lines)


# --- Endpoint ---------------------------------------------------------------------

URL = "/api/v1/expenses/extract-xml"


@pytest.fixture
def settings():
    return Settings(_env_file=None, jwt_secret="test-secret-with-at-least-32-bytes!!")


@pytest.fixture
def db(monkeypatch):
    state = SimpleNamespace(supplier=None, calls=[], checked_work=[])
    connection = MagicMock()

    def execute(sql, params=None):
        state.calls.append((sql, params))
        result = MagicMock()
        result.fetchone.return_value = state.supplier
        return result

    connection.execute.side_effect = execute

    @contextmanager
    def fake_transaction(current):
        yield connection

    monkeypatch.setattr(cfdi_module, "transaction", fake_transaction)
    monkeypatch.setattr(cfdi_module, "require_active_profile", lambda *args: None)
    monkeypatch.setattr(
        cfdi_module, "require_work_access", lambda c, u, work: state.checked_work.append(work)
    )
    return state


@pytest.fixture
def client(settings):
    app.dependency_overrides[get_settings] = lambda: settings
    yield TestClient(app)
    app.dependency_overrides.clear()


def auth(settings, role="operativo"):
    token = jwt.encode(
        {"sub": str(uuid4()), "aud": "authenticated", "app_metadata": {"role": role}},
        settings.jwt_secret, algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


def test_endpoint_returns_cfdi_and_a_ready_expense_draft_with_supplier_match(
    client, settings, db
):
    work_id, supplier_id = uuid4(), uuid4()
    db.supplier = {"id": supplier_id, "name": "Concretos", "active": True,
                   "assigned_to_work": True}
    response = client.post(
        URL, files={"file": ("factura.xml", invoice(), "application/xml")},
        data={"work_id": str(work_id)}, headers=auth(settings),
    )
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["uuid"] == UUID_SAT and data["issuer"]["rfc"] == "CPR990101AB1"
    assert data["supplier"]["id"] == str(supplier_id)
    assert db.checked_work == [work_id]
    [(sql, params)] = db.calls
    assert "regexp_replace(p.rfc" in sql and params[-1] == "CPR990101AB1"
    draft = data["expense"]
    assert draft["supplier_folio"] == "A-123"
    assert Decimal(draft["amount"]) == Decimal("1450.58")
    assert Decimal(draft["iva"]) == Decimal("200.08")
    assert [line["unit"] for line in draft["lines"]] == ["pieza", "pieza"]
    assert data["requires_review"] is False and data["warnings"] == []


def test_endpoint_reports_unknown_supplier_and_warnings(client, settings, db):
    response = client.post(
        URL, files={"file": ("f.xml", invoice(moneda="USD"), "text/xml")}, headers=auth(settings)
    )
    data = response.json()
    assert response.status_code == 200 and data["supplier"] is None
    assert data["requires_review"] is True and any("USD" in w for w in data["warnings"])


@pytest.mark.parametrize(
    ("name", "mime", "status_code"),
    [("factura.pdf", "application/pdf", 415), ("factura.xml", "image/png", 415)],
)
def test_endpoint_rejects_non_xml_files(client, settings, db, name, mime, status_code):
    response = client.post(URL, files={"file": (name, invoice(), mime)}, headers=auth(settings))
    assert response.status_code == status_code
    assert db.calls == []


def test_endpoint_rejects_oversized_and_invalid_xml(client, settings, db):
    settings.cfdi_max_bytes = 100
    big = client.post(URL, files={"file": ("f.xml", invoice(), "application/xml")},
                      headers=auth(settings))
    assert big.status_code == 413
    settings.cfdi_max_bytes = 2 * 1024 * 1024
    bad = client.post(URL, files={"file": ("f.xml", b"<!DOCTYPE x>", "application/xml")},
                      headers=auth(settings))
    assert bad.status_code == 422 and "DTD" in bad.json()["detail"]
    assert db.calls == []


def test_endpoint_requires_session(client, db):
    assert client.post(
        URL, files={"file": ("f.xml", invoice(), "application/xml")}
    ).status_code == 401
