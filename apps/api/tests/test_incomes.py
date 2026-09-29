from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.core.config import Settings
from app.models import IncomeCreate, IncomeState, LegacyIncomeCreate, Role, UserContext
from app.services import repository


def payload(**changes):
    return {"received_on": "2026-09-29", "concept": " Anticipo ", "amount": "1234.5678", **changes}


def test_income_model_preserves_exact_amount_and_defaults():
    income = IncomeCreate.model_validate(payload())
    assert income.amount == Decimal("1234.5678")
    assert income.received_on == date(2026, 9, 29)
    assert income.concept == "Anticipo"
    assert income.state is IncomeState.PENDIENTE


def test_legacy_income_rejects_blank_concept_before_repository_conversion():
    with pytest.raises(ValidationError):
        LegacyIncomeCreate(
            work_id=uuid4(), concept="   ", estimated_date=date(2026, 9, 29),
            amount=Decimal("10"), state="cobrado",
        )


@pytest.mark.parametrize("amount", ["0", "-1", "0.00001", "100000000000000", "NaN", "Infinity"])
def test_income_rejects_invalid_or_unrepresentable_amounts(amount):
    with pytest.raises(ValidationError):
        IncomeCreate.model_validate(payload(amount=amount))


@pytest.mark.parametrize(
    "changes",
    [
        {"concept": "   "},
        {"received_on": "2026-02-30"},
        {"state": "validado"},
        {"folio": "I-99999"},
        {"work_id": str(uuid4())},
        {"created_by": str(uuid4())},
    ],
)
def test_income_rejects_invalid_and_server_owned_fields(changes):
    with pytest.raises(ValidationError):
        IncomeCreate.model_validate(payload(**changes))


@pytest.mark.parametrize("state", [IncomeState.PENDIENTE, IncomeState.CONCILIADO])
def test_income_repository_passes_exact_decimal_and_audits(monkeypatch, state):
    connection = MagicMock()
    income_id, work_id = uuid4(), uuid4()
    connection.execute.return_value.fetchone.return_value = {"id": income_id}

    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    access = MagicMock()
    monkeypatch.setattr(repository, "require_work_access", access)
    user = UserContext(id=uuid4(), role=Role.ADMIN)
    result = repository.create_income(
        Settings(_env_file=None),
        user,
        work_id,
        IncomeCreate.model_validate(payload(amount="99999999999999.9999", state=state)),
    )
    access.assert_called_once_with(connection, user, work_id)
    calls = connection.execute.call_args_list
    [insert] = [call for call in calls if "insert into public.ingreso\n" in call.args[0]]
    assert insert.args[1] == (
        work_id,
        "Anticipo",
        date(2026, 9, 29),
        None,
        Decimal("99999999999999.9999"),
        state.value,
        user.id,
    )
    assert result["id"] == income_id
    assert any("insert into public.audit_log_negocio" in call.args[0] for call in calls)


def test_operativo_cannot_create_even_calling_repository_directly(monkeypatch):
    connection = MagicMock()

    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    monkeypatch.setattr(repository, "require_work_access", lambda *args: None)
    with pytest.raises(HTTPException) as error:
        repository.create_income(
            Settings(_env_file=None),
            UserContext(id=uuid4(), role=Role.OPERATIVO),
            uuid4(),
            IncomeCreate.model_validate(payload()),
        )
    assert error.value.status_code == 403
    connection.execute.assert_not_called()
