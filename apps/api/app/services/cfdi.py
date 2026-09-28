"""CFDI (factura electrónica del SAT, versiones 3.3 y 4.0) reader without AI.

Parses with the standard library after rejecting DTDs/entities (a CFDI never has
them), then maps the invoice to the expense model, where prices INCLUDE IVA.
CFDI unit values exclude taxes, so each concept is converted to a line whose
server-computed amount equals the concept's total with its taxes, exactly.
"""

import re
import xml.etree.ElementTree as ET  # noqa: N817 - conventional alias
from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status

from app.core.config import Settings
from app.models import UserContext, normalize_rfc
from app.services.repository import require_active_profile, require_work_access, transaction

CFDI_NAMESPACES = {"http://www.sat.gob.mx/cfd/4": "4.0", "http://www.sat.gob.mx/cfd/3": "3.3"}
TFD_NAMESPACE = "http://www.sat.gob.mx/TimbreFiscalDigital"
IVA = "002"
CENT = Decimal("0.01")
FOUR = Decimal("0.0001")
# Units most common in construction purchases; any other ClaveUnidad is shown as is.
UNIT_NAMES = {
    "H87": "pieza", "E48": "servicio", "ACT": "actividad", "KGM": "kg", "TNE": "tonelada",
    "MTR": "m", "MTK": "m2", "MTQ": "m3", "LTR": "litro", "XBX": "caja", "XBG": "bulto",
    "XSA": "saco", "SET": "juego", "PR": "par", "HUR": "hora", "DAY": "día", "EA": "pieza",
}
_DTD = re.compile(rb"<!\s*(DOCTYPE|ENTITY)", re.IGNORECASE)


class CfdiError(ValueError):
    pass


@dataclass
class CfdiConcept:
    clave_prod_serv: str | None
    cantidad: Decimal
    clave_unidad: str | None
    unidad: str | None
    descripcion: str
    valor_unitario: Decimal
    descuento: Decimal
    importe: Decimal
    iva_trasladado: Decimal
    otros_trasladados: Decimal  # IEPS and similar: part of the price paid, not IVA

    @property
    def total_con_impuestos(self) -> Decimal:
        return self.importe - self.descuento + self.iva_trasladado + self.otros_trasladados


@dataclass
class ParsedCfdi:
    version: str
    uuid: str | None
    serie: str | None
    folio: str | None
    fecha: str | None
    moneda: str | None
    tipo_comprobante: str | None
    emisor_rfc: str
    emisor_nombre: str | None
    emisor_regimen: str | None
    receptor_rfc: str | None
    subtotal: Decimal
    descuento: Decimal
    total: Decimal
    retenciones: Decimal
    conceptos: list[CfdiConcept]
    advertencias: list[str] = field(default_factory=list)

    @property
    def iva_trasladado(self) -> Decimal:
        return sum((c.iva_trasladado for c in self.conceptos), Decimal(0))


def _decimal(value: str | None, name: str, default: Decimal | None = None) -> Decimal:
    if value is None or value.strip() == "":
        if default is not None:
            return default
        raise CfdiError(f"Falta el atributo {name} en el CFDI")
    try:
        number = Decimal(value.strip())
    except InvalidOperation as exc:
        raise CfdiError(f"El atributo {name} no es numérico") from exc
    if not number.is_finite():
        raise CfdiError(f"El atributo {name} no es numérico")
    return number


def parse_cfdi(content: bytes) -> ParsedCfdi:
    if _DTD.search(content):
        raise CfdiError("XML con DTD o entidades no permitido")
    try:
        root = ET.fromstring(content)
    except ET.ParseError as exc:
        raise CfdiError("El archivo no es un XML válido") from exc
    namespace, _, local = root.tag[1:].partition("}") if root.tag.startswith("{") else ("", "", "")
    if local != "Comprobante" or namespace not in CFDI_NAMESPACES:
        raise CfdiError("El XML no es un CFDI del SAT (versión 3.3 o 4.0)")
    ns = {"cfdi": namespace, "tfd": TFD_NAMESPACE}

    emisor = root.find("cfdi:Emisor", ns)
    if emisor is None or not (emisor.get("Rfc") or "").strip():
        raise CfdiError("El CFDI no indica el RFC del emisor")
    receptor = root.find("cfdi:Receptor", ns)
    timbre = root.find("cfdi:Complemento/tfd:TimbreFiscalDigital", ns)

    conceptos: list[CfdiConcept] = []
    for node in root.findall("cfdi:Conceptos/cfdi:Concepto", ns):
        iva = otros = Decimal(0)
        for traslado in node.findall("cfdi:Impuestos/cfdi:Traslados/cfdi:Traslado", ns):
            if traslado.get("TipoFactor") == "Exento":
                continue
            amount = _decimal(traslado.get("Importe"), "Traslado.Importe", Decimal(0))
            if traslado.get("Impuesto") == IVA:
                iva += amount
            else:
                otros += amount
        conceptos.append(
            CfdiConcept(
                clave_prod_serv=node.get("ClaveProdServ"),
                cantidad=_decimal(node.get("Cantidad"), "Concepto.Cantidad"),
                clave_unidad=node.get("ClaveUnidad"),
                unidad=node.get("Unidad"),
                descripcion=(node.get("Descripcion") or "").strip() or "Concepto sin descripción",
                valor_unitario=_decimal(node.get("ValorUnitario"), "Concepto.ValorUnitario"),
                descuento=_decimal(node.get("Descuento"), "Concepto.Descuento", Decimal(0)),
                importe=_decimal(node.get("Importe"), "Concepto.Importe"),
                iva_trasladado=iva,
                otros_trasladados=otros,
            )
        )
    if not conceptos:
        raise CfdiError("El CFDI no contiene conceptos")
    if any(c.cantidad <= 0 or c.importe < 0 or c.descuento < 0 for c in conceptos):
        raise CfdiError("El CFDI contiene cantidades o importes inválidos")

    impuestos = root.find("cfdi:Impuestos", ns)
    retenciones = _decimal(
        impuestos.get("TotalImpuestosRetenidos") if impuestos is not None else None,
        "TotalImpuestosRetenidos",
        Decimal(0),
    )
    parsed = ParsedCfdi(
        version=CFDI_NAMESPACES[namespace],
        uuid=timbre.get("UUID") if timbre is not None else None,
        serie=root.get("Serie"),
        folio=root.get("Folio"),
        fecha=root.get("Fecha"),
        moneda=root.get("Moneda"),
        tipo_comprobante=root.get("TipoDeComprobante"),
        emisor_rfc=emisor.get("Rfc", "").strip().upper(),
        emisor_nombre=emisor.get("Nombre"),
        emisor_regimen=emisor.get("RegimenFiscal"),
        receptor_rfc=receptor.get("Rfc") if receptor is not None else None,
        subtotal=_decimal(root.get("SubTotal"), "SubTotal"),
        descuento=_decimal(root.get("Descuento"), "Descuento", Decimal(0)),
        total=_decimal(root.get("Total"), "Total"),
        retenciones=retenciones,
        conceptos=conceptos,
    )
    _review(parsed)
    return parsed


def _review(cfdi: ParsedCfdi) -> None:
    """Cross-check the invoice; findings become warnings for a human, never silent fixes."""
    notes = cfdi.advertencias
    tolerance = CENT * len(cfdi.conceptos)  # SAT allows per-concept rounding
    if cfdi.uuid is None:
        notes.append("El XML no tiene Timbre Fiscal Digital (UUID): no es un CFDI timbrado.")
    if (cfdi.moneda or "MXN") != "MXN":
        notes.append(f"La moneda del CFDI es {cfdi.moneda}; el sistema registra sólo MXN.")
    if cfdi.tipo_comprobante not in (None, "I"):
        notes.append(
            f"El CFDI es de tipo {cfdi.tipo_comprobante} (no es de ingreso): "
            "E = nota de crédito, P = pago, T = traslado."
        )
    if abs(sum((c.importe for c in cfdi.conceptos), Decimal(0)) - cfdi.subtotal) > tolerance:
        notes.append("La suma de importes de los conceptos no coincide con el SubTotal.")
    if abs(sum((c.descuento for c in cfdi.conceptos), Decimal(0)) - cfdi.descuento) > tolerance:
        notes.append("La suma de descuentos de los conceptos no coincide con el Descuento.")
    expected_total = cfdi.subtotal - cfdi.descuento + sum(
        (c.iva_trasladado + c.otros_trasladados for c in cfdi.conceptos), Decimal(0)
    ) - cfdi.retenciones
    if abs(expected_total - cfdi.total) > tolerance:
        notes.append("SubTotal − Descuento + impuestos no coincide con el Total del CFDI.")
    if cfdi.retenciones > 0:
        notes.append(
            f"El CFDI tiene retenciones por {cfdi.retenciones}: el gasto se registra antes de "
            "retenciones; confirma el monto efectivamente pagado."
        )


@dataclass(frozen=True)
class MappedLine:
    quantity: Decimal
    unit: str
    description: str
    unit_price: Decimal
    discount: Decimal
    amount: Decimal  # what expense_totals.line_amount() will compute for this line


def _half_up(value: Decimal, exponent: Decimal = CENT) -> Decimal:
    return value.quantize(exponent, rounding=ROUND_HALF_UP)


def map_concept(concept: CfdiConcept) -> MappedLine:
    """One CFDI concept → one expense line (price with taxes) with an exact amount.

    unit_price is rounded UP to 4 decimals so quantity × price ≥ target, and the few
    cents of rounding go to `discount`; the backend then computes exactly `target`.
    """
    target = _half_up(concept.total_con_impuestos)
    quantity = concept.cantidad
    description = concept.descripcion
    if quantity != quantity.quantize(FOUR) or quantity > Decimal("9999999999"):
        # The expense model stores 4 decimals: keep the CFDI quantity in the text.
        description = f"{concept.cantidad} × {description}"
        quantity = Decimal(1)
    unit_price = (target / quantity).quantize(FOUR, rounding=ROUND_CEILING)
    discount = _half_up(quantity * unit_price) - target
    unit = (concept.unidad or UNIT_NAMES.get(concept.clave_unidad or "") or
            concept.clave_unidad or "pieza").strip()[:40]
    return MappedLine(
        quantity=quantity.quantize(FOUR),
        unit=unit,
        description=description[:500],
        unit_price=unit_price,
        discount=discount,
        amount=_half_up(quantity * unit_price - discount),
    )


def expense_iva(cfdi: ParsedCfdi) -> Decimal:
    return _half_up(cfdi.iva_trasladado)


# --- Service (DB lookup + HTTP mapping) -------------------------------------------

XML_TYPES = {"application/xml", "text/xml", "application/octet-stream", ""}


def extract_cfdi(
    settings: Settings,
    user: UserContext,
    content: bytes,
    declared_type: str | None,
    filename: str | None,
    work_id: UUID | None,
) -> dict[str, Any]:
    if len(content) > settings.cfdi_max_bytes:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            f"El XML excede {settings.cfdi_max_bytes // (1024 * 1024)} MB",
        )
    declared = (declared_type or "").split(";")[0].strip().lower()
    if declared not in XML_TYPES or not (filename or "").lower().endswith(".xml"):
        raise HTTPException(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "El archivo debe ser el XML del CFDI"
        )
    try:
        cfdi = parse_cfdi(content)
    except CfdiError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc

    with transaction(settings) as connection:
        require_active_profile(connection, user)
        if work_id is not None:
            require_work_access(connection, user, work_id)
        supplier = None
        try:
            rfc = normalize_rfc(cfdi.emisor_rfc)
        except ValueError:
            cfdi.advertencias.append("El RFC del emisor no tiene un formato válido.")
            rfc = None
        if rfc:
            supplier = connection.execute(
                """
                select p.id, p.nombre as name, p.activo as active,
                       case when %s::uuid is null then null else exists (
                         select 1 from public.obra_proveedor op
                         where op.proveedor_id = p.id and op.obra_id = %s and op.activo
                       ) end as assigned_to_work
                from public.catalogo_proveedor p
                where upper(regexp_replace(p.rfc, '[^A-Za-z0-9]', '', 'g')) = %s
                """,
                (work_id, work_id, rfc),
            ).fetchone()

    lines = [map_concept(concept) for concept in cfdi.conceptos]
    amount = sum((line.amount for line in lines), Decimal(0))
    supplier_folio = "-".join(part for part in (cfdi.serie, cfdi.folio) if part) or (
        cfdi.uuid[:8].upper() if cfdi.uuid else None
    )
    issuer = cfdi.emisor_nombre or cfdi.emisor_rfc
    concept = f"CFDI {supplier_folio or ''} · {issuer}".replace("  ", " ")[:500]
    return {
        "version": cfdi.version,
        "uuid": cfdi.uuid,
        "series": cfdi.serie,
        "folio": cfdi.folio,
        "issued_at": cfdi.fecha,
        "currency": cfdi.moneda,
        "voucher_type": cfdi.tipo_comprobante,
        "issuer": {"rfc": cfdi.emisor_rfc, "name": cfdi.emisor_nombre,
                   "tax_regime": cfdi.emisor_regimen},
        "receiver_rfc": cfdi.receptor_rfc,
        "concepts": [
            {"product_code": c.clave_prod_serv, "quantity": c.cantidad, "unit_code": c.clave_unidad,
             "unit": c.unidad, "description": c.descripcion, "unit_value": c.valor_unitario,
             "discount": c.descuento, "amount": c.importe, "iva": c.iva_trasladado}
            for c in cfdi.conceptos
        ],
        "subtotal": cfdi.subtotal,
        "discount": cfdi.descuento,
        "iva": cfdi.iva_trasladado,
        "withholdings": cfdi.retenciones,
        "total": cfdi.total,
        "supplier": supplier,
        "expense": {
            "supplier_folio": supplier_folio[:120] if supplier_folio else None,
            "concept": concept if len(concept) >= 3 else "Factura CFDI",
            "lines": [
                {"quantity": line.quantity, "unit": line.unit, "description": line.description,
                 "unit_price": line.unit_price, "discount": line.discount}
                for line in lines
            ],
            "iva": expense_iva(cfdi),
            "amount": amount,
        },
        "requires_review": bool(cfdi.advertencias),
        "warnings": cfdi.advertencias,
    }
