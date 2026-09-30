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


def test_spend_breakdown_groups_by_item_and_category():
    material, labor, tools = uuid4(), uuid4(), uuid4()
    prelim, structure = uuid4(), uuid4()
    rows = [
        {"item_id": prelim, "item": "PRELIMINARES", "item_order": 1, "category_id": material,
         "category": "MATERIAL", "category_order": 1, "validated": Decimal("100"),
         "committed": Decimal("150"), "expense_count": 2},
        {"item_id": prelim, "item": "PRELIMINARES", "item_order": 1, "category_id": labor,
         "category": "MANO DE OBRA", "category_order": 2, "validated": Decimal("50"),
         "committed": Decimal("50"), "expense_count": 1},
        {"item_id": structure, "item": "ESTRUCTURA", "item_order": 5, "category_id": material,
         "category": "MATERIAL", "category_order": 1, "validated": Decimal("250"),
         "committed": Decimal("250"), "expense_count": 1},
        {"item_id": None, "item": "Sin partida", "item_order": 999, "category_id": None,
         "category": "Sin categoría", "category_order": 999, "validated": Decimal("0"),
         "committed": Decimal("20"), "expense_count": 1},
    ]
    catalog = [{"id": material, "nombre": "MATERIAL", "orden": 1},
               {"id": labor, "nombre": "MANO DE OBRA", "orden": 2},
               {"id": tools, "nombre": "EQUIPO/HERR", "orden": 3}]
    connection = MagicMock()
    connection.execute.side_effect = [
        MagicMock(fetchall=MagicMock(return_value=rows)),
        MagicMock(fetchall=MagicMock(return_value=catalog)),
    ]
    result = repository._spend_breakdown(connection, uuid4(), date(2026, 9, 30), Decimal("400"))
    assert [item["name"] for item in result["items"]] == [
        "ESTRUCTURA", "PRELIMINARES", "Sin partida",
    ]
    prelim_row = result["items"][1]
    assert prelim_row["validated"] == Decimal("150") and prelim_row["pending"] == Decimal("50")
    assert prelim_row["share_percent"] == Decimal("37.5")
    assert prelim_row["expense_count"] == 3
    assert {c["name"]: c["validated"] for c in prelim_row["categories"]} == {
        "MATERIAL": Decimal("100"), "MANO DE OBRA": Decimal("50"),
    }
    # The three catalog categories always appear (EQUIPO/HERR at zero), legacy last.
    assert [(c["name"], c["validated"]) for c in result["categories"]] == [
        ("MATERIAL", Decimal("350")), ("MANO DE OBRA", Decimal("50")),
        ("EQUIPO/HERR", Decimal("0")), ("Sin categoría", Decimal("0")),
    ]
    assert result["categories"][0]["share_percent"] == Decimal("87.5")


def test_spend_breakdown_without_validated_spend_has_zero_shares():
    connection = MagicMock()
    connection.execute.side_effect = [
        MagicMock(fetchall=MagicMock(return_value=[])),
        MagicMock(fetchall=MagicMock(return_value=[{"id": uuid4(), "nombre": "MATERIAL",
                                                    "orden": 1}])),
    ]
    result = repository._spend_breakdown(connection, uuid4(), date(2026, 9, 30), Decimal("0"))
    assert result["items"] == []
    assert result["categories"][0]["share_percent"] == Decimal("0")
