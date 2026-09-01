from decimal import Decimal
from io import BytesIO
from pathlib import Path

import pytest
from openpyxl import Workbook

from app.services.neodata import NeodataError, UnsafeWorkbookError, parse_neodata_workbook


def workbook_bytes(*, external_link: bool = False) -> bytes:
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "Presupuesto"
    sheet.append(["Código", "Concepto", "Unidad", "Cantidad", "P. Unitario", "Importe"])
    sheet.append([None, "PRESUPUESTO OFICINA", None, None, None, None])
    sheet.append(["PRELIMINARES", "PRELIMINARES", None, None, None, None])
    sheet.append(["PRE-01", "Trazo y nivelación", "M2", 2, 10, "=D4*E4"])
    sheet.append([None, "incluye herramienta", None, 0, 0, 0])
    sheet.append(["PRELIMINARES", "TOTAL PRELIMINARES", None, None, 0, 20])
    sheet.append(["TOTAL DEL PRESUPUESTO MOSTRADO SIN IVA:", None, None, None, None, 20])
    if external_link:
        sheet["H1"] = "='[external.xlsx]Sheet1'!A1"
    output = BytesIO()
    workbook.save(output)
    return output.getvalue()


def test_synthetic_preview_preserves_continuation_and_totals() -> None:
    preview = parse_neodata_workbook(workbook_bytes(), "presupuesto.xlsx")

    assert preview.areas == {"Oficina": 1}
    assert len(preview.items) == 1
    assert preview.items[0].description == "Trazo y nivelación incluye herramienta"
    assert str(preview.calculated_total_without_vat) == "20"
    assert preview.section_totals[0].difference == 0
    assert preview.unclassified == []


@pytest.mark.parametrize(
    ("content", "filename", "error"),
    [
        (b"not-a-zip", "presupuesto.xlsx", NeodataError),
        (workbook_bytes(), "presupuesto.xlsm", UnsafeWorkbookError),
        (workbook_bytes(), "presupuesto.csv", NeodataError),
    ],
    ids=["corrupt", "macro", "wrong-extension"],
)
def test_rejects_unsafe_or_invalid_files(
    content: bytes, filename: str, error: type[Exception]
) -> None:
    with pytest.raises(error):
        parse_neodata_workbook(content, filename)


def test_rejects_external_formula_links() -> None:
    with pytest.raises(UnsafeWorkbookError, match="enlaces externos"):
        parse_neodata_workbook(workbook_bytes(external_link=True), "presupuesto.xlsx")


def test_enforces_file_size_limit() -> None:
    with pytest.raises(NeodataError, match="debe medir"):
        parse_neodata_workbook(workbook_bytes(), "presupuesto.xlsx", max_bytes=100)


def test_real_toluca_workbook_regression() -> None:
    fixture = Path(
        "/var/www/Apparquitectos/20260816 INFRA TOLUCA OFICINA-COMEDOR Y BAÑOS "
        "COMPETO JUNTOS (2).xlsx"
    )
    if not fixture.exists():
        pytest.skip("El Excel real se mantiene intencionalmente fuera de Git")

    preview = parse_neodata_workbook(fixture.read_bytes(), fixture.name)

    assert preview.sheets == ["b)Estandar (E)"]
    assert preview.row_count == 1154
    assert preview.areas == {"Oficina": 81, "Comedor": 65, "Baños": 86}
    assert len(preview.items) == 232
    assert len(preview.section_totals) == 40
    assert preview.unclassified == []
    assert all(abs(total.difference) <= 0.02 for total in preview.section_totals)
    assert abs(
        preview.calculated_total_without_vat - Decimal("2624832.8848544")
    ) <= Decimal("0.001")
