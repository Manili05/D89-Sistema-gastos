from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.models import ExpenseCreate
from app.services.repository import _consolidate_preview_items


def item(*, description: str, quantity: str, unit_price: str, amount: str) -> dict[str, object]:
    return {
        "sheet": "Presupuesto",
        "row": 20,
        "area": "General",
        "work_class": "PRELIMINARES",
        "category": None,
        "code": "PRE-01",
        "description": description,
        "unit": "M2",
        "quantity": quantity,
        "unit_price": unit_price,
        "amount": amount,
    }


def test_consolidates_exact_budget_identities_without_losing_amount() -> None:
    source = [
        item(description="Trazo", quantity="2", unit_price="10", amount="20"),
        item(description="Trazo", quantity="3", unit_price="12", amount="36"),
        item(description="Nivelación", quantity="1", unit_price="8", amount="8"),
    ]

    result = _consolidate_preview_items(source)

    assert len(result) == 2
    assert result[0]["quantity"] == "5"
    assert result[0]["amount"] == "56"
    assert Decimal(str(result[0]["unit_price"])) == Decimal("11.200000")
    assert sum(Decimal(str(row["amount"])) for row in result) == Decimal("64")


def expense_payload() -> dict[str, object]:
    return {
        "work_id": uuid4(),
        "area_id": uuid4(),
        "expense_item_id": uuid4(),
        "expense_subitem_id": uuid4(),
        "expense_category_id": uuid4(),
        "spent_on": date(2026, 9, 3),
        "concept": "Material para firme",
        "amount": "1250.00",
    }


def test_expense_requires_exactly_one_supplier_source() -> None:
    payload = expense_payload()
    with pytest.raises(ValidationError, match="proveedor"):
        ExpenseCreate.model_validate(payload)

    expense = ExpenseCreate.model_validate({**payload, "supplier_name": "  Concretos Toluca  "})
    assert expense.supplier_name == "Concretos Toluca"

    with pytest.raises(ValidationError, match="proveedor"):
        ExpenseCreate.model_validate(
            {**payload, "supplier_id": uuid4(), "supplier_name": "Concretos Toluca"}
        )
