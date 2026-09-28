from datetime import date
from decimal import Decimal
from uuid import uuid4

import pytest
from pydantic import ValidationError

from app.models import (
    ExpenseCreate,
    SupplierCreate,
    SupplierEvaluationCreate,
    SupplierSpecialtyCreate,
)
from app.services.repository import _consolidate_preview_items


def item(*, description: str, quantity: str, unit_price: str, amount: str) -> dict[str, object]:
    return {
        "sheet": "Presupuesto",
        "row": 20,
        "area": "General",
        "area_path": ["General"],
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
        "lines": [
            {"quantity": "10", "unit": "bulto", "description": "Cemento", "unit_price": "125"}
        ],
    }


def test_expense_requires_a_directory_supplier() -> None:
    payload = expense_payload()
    with pytest.raises(ValidationError, match="supplier_id"):
        ExpenseCreate.model_validate(payload)

    supplier_id = uuid4()
    expense = ExpenseCreate.model_validate({**payload, "supplier_id": supplier_id})
    assert expense.supplier_id == supplier_id


def test_expense_lines_are_validated_and_client_totals_are_not_accepted() -> None:
    payload = {**expense_payload(), "supplier_id": uuid4()}
    expense = ExpenseCreate.model_validate(
        {
            **payload,
            "supplier_folio": "A-1",
            "amount": "999999",  # ignored: the server derives the total from the lines
            "lines": [
                {"quantity": "2", "unit": "  m3 ", "description": " Grava ", "unit_price": "10"}
            ],
        }
    )
    assert not hasattr(expense, "amount")
    assert expense.supplier_folio == "A-1"
    assert (expense.lines[0].unit, expense.lines[0].description) == ("m3", "Grava")
    assert expense.lines[0].discount == 0

    with pytest.raises(ValidationError, match="lines"):
        ExpenseCreate.model_validate({**payload, "lines": []})
    with pytest.raises(ValidationError, match="descuento"):
        ExpenseCreate.model_validate(
            {
                **payload,
                "lines": [
                    {"quantity": "1", "unit": "pza", "description": "Tubo",
                     "unit_price": "10", "discount": "10.01"}
                ],
            }
        )
    for bad_line in (
        {"quantity": "0", "unit": "pza", "description": "Tubo", "unit_price": "10"},
        {"quantity": "1", "unit": "", "description": "Tubo", "unit_price": "10"},
        {"quantity": "1", "unit": "pza", "description": "Tubo", "unit_price": "-1"},
    ):
        with pytest.raises(ValidationError):
            ExpenseCreate.model_validate({**payload, "lines": [bad_line]})


def test_supplier_normalizes_rfc_and_specialties() -> None:
    specialty_id = uuid4()
    supplier = SupplierCreate.model_validate(
        {
            "name": "  Carpintería Norte  ",
            "tax_id": "abc-010203-xy9",
            "email": "contacto@example.com",
            "specialty_ids": [specialty_id, specialty_id],
        }
    )

    assert supplier.name == "Carpintería Norte"
    assert supplier.tax_id == "ABC010203XY9"
    assert supplier.specialty_ids == [specialty_id]


def test_supplier_accepts_csf_fiscal_data() -> None:
    supplier = SupplierCreate.model_validate(
        {
            "name": "Concretos Toluca",
            "tax_regime": "  601 - General de Ley Personas Morales ",
            "postal_code": " 50000 ",
        }
    )
    assert supplier.tax_regime == "601 - General de Ley Personas Morales"
    assert supplier.postal_code == "50000"
    blank = SupplierCreate.model_validate({"name": "Sin CSF", "postal_code": "  "})
    assert blank.postal_code is None
    for invalid in ("5000", "500000", "5OOOO", "５００００"):
        with pytest.raises(ValidationError):
            SupplierCreate.model_validate({"name": "Proveedor", "postal_code": invalid})


def test_supplier_evaluation_enforces_five_point_scale() -> None:
    payload = {
        "work_id": uuid4(),
        "work_description": "Instalación de muebles",
        "service_date": date(2026, 9, 4),
        "quality": 5,
        "timeliness": 4,
        "value": 4,
        "communication": 5,
        "safety": 4,
    }
    evaluation = SupplierEvaluationCreate.model_validate(payload)
    assert evaluation.quality == 5

    with pytest.raises(ValidationError, match="less than or equal to 5"):
        SupplierEvaluationCreate.model_validate({**payload, "quality": 6})


def test_supplier_specialty_rejects_blank_names() -> None:
    with pytest.raises(ValidationError, match="at least 2 characters"):
        SupplierSpecialtyCreate.model_validate({"name": "   "})
