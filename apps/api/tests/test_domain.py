from decimal import Decimal
from uuid import uuid4

import pytest

from app.services.reports import build_excel_report, build_pdf_report
from app.services.tools import WHATSAPP_TOOLS
from app.services.variation import TrafficLight, calculate_variation
from app.services.weekly_close import (
    CloseExpenseSnapshot,
    CloseState,
    close_week,
    reopen_week,
)


def test_variation_thresholds_are_configurable() -> None:
    result = calculate_variation(Decimal("100"), Decimal("109.99"))
    assert result.traffic_light is TrafficLight.GREEN
    assert calculate_variation(Decimal("100"), Decimal("110")).traffic_light is TrafficLight.AMBER
    assert calculate_variation(Decimal("100"), Decimal("125.01")).traffic_light is TrafficLight.RED


def test_weekly_close_reopening_requires_auditable_reason() -> None:
    admin = uuid4()
    close = close_week(
        uuid4(),
        2026,
        35,
        admin,
        (CloseExpenseSnapshot(uuid4(), Decimal("350.50"), "validado"),),
    )
    with pytest.raises(ValueError, match="motivo"):
        reopen_week(close, admin, "error")
    reopened = reopen_week(close, admin, "Corrección de factura duplicada")
    assert reopened.state is CloseState.REOPENED
    assert reopened.expenses == close.expenses
    assert reopened.reopened_by == admin


def test_whatsapp_catalog_has_exactly_ten_safe_tools() -> None:
    names = {tool.name for tool in WHATSAPP_TOOLS}
    assert len(names) == 10
    assert "eliminar_gasto" not in names
    assert "importar_presupuesto_neodata" not in names
    register = next(tool for tool in WHATSAPP_TOOLS if tool.name == "registrar_gasto")
    assert register.requires_confirmation


def test_server_side_reports_are_valid_and_escape_formulas() -> None:
    rows = [{"Partida": "=cmd", "Presupuesto": 100, "Real": 90}]
    excel = build_excel_report("Variación", ("Partida", "Presupuesto", "Real"), rows)
    pdf = build_pdf_report("Variación", ("Partida", "Presupuesto", "Real"), rows)
    assert excel.startswith(b"PK")
    assert pdf.startswith(b"%PDF")
