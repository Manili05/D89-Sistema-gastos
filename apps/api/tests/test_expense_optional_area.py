"""Cambio 8: the NEODATA area is an optional link; the catalog classification leads."""

from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.models import ExpenseCreate, ExpenseUpdate, Role, UserContext
from app.services import repository

LINES = [{"quantity": "1", "unit": "pza", "description": "Cemento", "unit_price": "100"}]


def payload(**changes):
    return {
        "work_id": str(uuid4()),
        "expense_item_id": str(uuid4()),
        "expense_subitem_id": str(uuid4()),
        "expense_category_id": str(uuid4()),
        "supplier_id": str(uuid4()),
        "spent_on": "2026-09-30",
        "concept": "Cemento para firme",
        "lines": LINES,
        **changes,
    }


@pytest.mark.parametrize("model", [ExpenseCreate, ExpenseUpdate])
def test_area_is_optional(model):
    data = payload() if model is ExpenseCreate else {
        key: value for key, value in payload().items() if key != "work_id"
    }
    assert model.model_validate(data).area_id is None
    assert model.model_validate({**data, "area_id": None}).area_id is None


@pytest.mark.parametrize("model", [ExpenseCreate, ExpenseUpdate])
def test_neodata_budget_item_requires_area(model):
    data = payload(budget_item_id=str(uuid4()))
    if model is ExpenseUpdate:
        data.pop("work_id")
    with pytest.raises(ValidationError, match="requiere un área"):
        model.model_validate(data)
    assert model.model_validate({**data, "area_id": str(uuid4())}).budget_item_id


@pytest.mark.parametrize("field", ["expense_item_id", "expense_subitem_id",
                                   "expense_category_id", "supplier_id"])
def test_catalog_classification_and_supplier_stay_required(field):
    data = payload()
    data.pop(field)
    with pytest.raises(ValidationError):
        ExpenseCreate.model_validate(data)


def _connection():
    connection = MagicMock()

    def execute(sql, params=None):
        result = MagicMock()
        if "from public.cierre_semanal c" in sql:
            result.fetchone.return_value = {"locked": False}
        else:
            result.fetchone.return_value = {"id": uuid4(), "folio": "G-00001"}
        return result

    connection.execute.side_effect = execute
    return connection


def test_create_without_area_skips_area_check_and_inserts_null(monkeypatch):
    connection = _connection()

    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    monkeypatch.setattr(repository, "require_work_access", lambda *args: None)
    monkeypatch.setattr(repository, "_expense_detail", lambda *args: {"id": "ok"})
    data = ExpenseCreate.model_validate(payload())
    repository.create_expense(
        Settings(_env_file=None), UserContext(id=uuid4(), role=Role.OPERATIVO), data
    )
    sql = [call.args[0] for call in connection.execute.call_args_list]
    assert not any("from public.area" in query for query in sql)
    [insert] = [c for c in connection.execute.call_args_list
                if "insert into public.gasto (" in c.args[0]]
    assert insert.args[1][1] is None  # obra_id, area_id, ...


def test_create_with_foreign_area_is_rejected(monkeypatch):
    connection = MagicMock()

    def execute(sql, params=None):
        result = MagicMock()
        if "from public.cierre_semanal c" in sql:
            result.fetchone.return_value = {"locked": False}
        elif "from public.area" in sql:
            result.fetchone.return_value = None
        else:
            result.fetchone.return_value = {"id": uuid4()}
        return result

    connection.execute.side_effect = execute

    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    monkeypatch.setattr(repository, "require_work_access", lambda *args: None)
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as error:
        repository.create_expense(
            Settings(_env_file=None), UserContext(id=uuid4(), role=Role.ADMIN),
            ExpenseCreate.model_validate(payload(area_id=str(uuid4()))),
        )
    assert error.value.status_code == 422


def _row(item_id, item, order, subitem_id, subitem, category_id, category, category_order,
         validated, pending, count):
    return {
        "item_id": item_id, "item": item, "item_order": order, "subitem_id": subitem_id,
        "subitem": subitem, "subitem_order": 1, "category_id": category_id,
        "category": category, "category_order": category_order,
        "validated": Decimal(validated), "pending": Decimal(pending), "expense_count": count,
    }


def _breakdown(rows, suppliers, catalog, total):
    connection = MagicMock()
    connection.execute.side_effect = [
        MagicMock(fetchall=MagicMock(return_value=rows)),
        MagicMock(fetchall=MagicMock(return_value=suppliers)),
        MagicMock(fetchall=MagicMock(return_value=catalog)),
    ]
    return repository._spend_breakdown(connection, uuid4(), date(2026, 9, 30), Decimal(total))


def test_spend_breakdown_nests_item_subitem_category_and_lists_suppliers():
    material, labor, tools = uuid4(), uuid4(), uuid4()
    prelim, structure, cleaning, layout, steel = uuid4(), uuid4(), uuid4(), uuid4(), uuid4()
    rows = [
        _row(prelim, "PRELIMINARES", 1, cleaning, "LIMPIEZA", material, "MATERIAL", 1,
             "100", "50", 2),
        _row(prelim, "PRELIMINARES", 1, cleaning, "LIMPIEZA", labor, "MANO DE OBRA", 2,
             "30", "0", 1),
        _row(prelim, "PRELIMINARES", 1, layout, "TRAZO Y NIVEL", labor, "MANO DE OBRA", 2,
             "20", "0", 1),
        _row(structure, "ESTRUCTURA", 5, steel, "ESTRUCTURA METALICA", material, "MATERIAL",
             1, "250", "0", 1),
        _row(None, "Sin partida", 999, None, "Sin subpartida", None, "Sin categoría", 999,
             "0", "20", 1),
    ]
    supplier_a, supplier_b = uuid4(), uuid4()
    suppliers = [
        {"id": supplier_a, "name": "Concretos", "validated": Decimal("100"),
         "pending": Decimal("70"), "expense_count": 4},
        {"id": supplier_b, "name": "Aceros", "validated": Decimal("300"),
         "pending": Decimal("0"), "expense_count": 2},
    ]
    catalog = [{"id": material, "nombre": "MATERIAL", "orden": 1},
               {"id": labor, "nombre": "MANO DE OBRA", "orden": 2},
               {"id": tools, "nombre": "EQUIPO/HERR", "orden": 3}]
    result = _breakdown(rows, suppliers, catalog, "400")

    assert [item["name"] for item in result["items"]] == [
        "ESTRUCTURA", "PRELIMINARES", "Sin partida",
    ]
    prelim_row = result["items"][1]
    assert (prelim_row["validated"], prelim_row["pending"], prelim_row["committed"]) == (
        Decimal("150"), Decimal("50"), Decimal("200"),
    )
    assert prelim_row["share_percent"] == Decimal("37.5") and prelim_row["expense_count"] == 4
    assert [(c["name"], c["validated"], c["pending"]) for c in prelim_row["categories"]] == [
        ("MATERIAL", Decimal("100"), Decimal("50")), ("MANO DE OBRA", Decimal("50"), Decimal("0")),
    ]
    # Subitems ordered by validated spend, each with its categories.
    cleaning_row, layout_row = prelim_row["subitems"]
    assert (cleaning_row["name"], cleaning_row["validated"], cleaning_row["pending"]) == (
        "LIMPIEZA", Decimal("130"), Decimal("50"),
    )
    assert [(c["name"], c["validated"]) for c in cleaning_row["categories"]] == [
        ("MATERIAL", Decimal("100")), ("MANO DE OBRA", Decimal("30")),
    ]
    assert layout_row["name"] == "TRAZO Y NIVEL" and layout_row["share_percent"] == Decimal("5")
    # The three catalog categories always appear (EQUIPO/HERR at zero), legacy last.
    assert [(c["name"], c["validated"], c["pending"]) for c in result["categories"]] == [
        ("MATERIAL", Decimal("350"), Decimal("50")), ("MANO DE OBRA", Decimal("50"), Decimal("0")),
        ("EQUIPO/HERR", Decimal("0"), Decimal("0")), ("Sin categoría", Decimal("0"),
                                                       Decimal("20")),
    ]
    assert result["categories"][0]["share_percent"] == Decimal("87.5")
    # Every supplier with spend, largest validated first, share of the validated total.
    assert [(p["name"], p["validated"], p["pending"], p["committed"], p["expense_count"],
             p["share_percent"]) for p in result["providers"]] == [
        ("Aceros", Decimal("300"), Decimal("0"), Decimal("300"), 2, Decimal("75")),
        ("Concretos", Decimal("100"), Decimal("70"), Decimal("170"), 4, Decimal("25")),
    ]


def test_spend_breakdown_without_validated_spend_has_zero_shares():
    supplier = {"id": uuid4(), "name": "Concretos", "validated": Decimal("0"),
                "pending": Decimal("10"), "expense_count": 1}
    result = _breakdown([], [supplier], [{"id": uuid4(), "nombre": "MATERIAL", "orden": 1}], "0")
    assert result["items"] == []
    assert result["categories"][0]["share_percent"] == Decimal("0")
    assert result["providers"][0]["share_percent"] == Decimal("0")
    assert result["providers"][0]["committed"] == Decimal("10")
