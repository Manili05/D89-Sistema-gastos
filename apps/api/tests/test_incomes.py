from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException
from pydantic import ValidationError

from app.core.config import Settings
from app.models import (
    IncomeBatchReconcile,
    IncomeCreate,
    IncomeState,
    IncomeStatusUpdate,
    IncomeUpdate,
    LegacyIncomeCreate,
    Role,
    UserContext,
)
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
        state.value,
        user.id,
        state.value,
    )
    assert "conciliado_por, conciliado_en" in insert.args[0]
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


@pytest.mark.parametrize("reason", [None, "", "   ", "abc"])
def test_reverting_reconciliation_requires_a_reason(reason):
    with pytest.raises(ValidationError):
        IncomeStatusUpdate.model_validate({"state": "pendiente", "reason": reason})


def test_status_update_accepts_reconcile_without_reason_and_trims():
    assert IncomeStatusUpdate.model_validate({"state": "conciliado"}).reason is None
    update = IncomeStatusUpdate.model_validate(
        {"state": "pendiente", "reason": "  Error de captura "}
    )
    assert update.reason == "Error de captura"
    with pytest.raises(ValidationError):
        IncomeStatusUpdate.model_validate({"state": "validado"})
    with pytest.raises(ValidationError):
        IncomeStatusUpdate.model_validate({"state": "pendiente", "reason": "x" * 501})


@pytest.mark.parametrize("ids", [[], [str(uuid4()) for _ in range(101)]])
def test_batch_reconcile_bounds(ids):
    with pytest.raises(ValidationError):
        IncomeBatchReconcile.model_validate({"work_id": str(uuid4()), "income_ids": ids})


def _status_repo(monkeypatch, row):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = row

    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    monkeypatch.setattr(repository, "require_work_access", lambda *args: None)
    monkeypatch.setattr(repository, "_income_detail", lambda *args: {"id": "ok"})
    return connection


@pytest.mark.parametrize(
    ("row", "role", "state", "expected"),
    [
        ({"obra_id": uuid4(), "estado": "pendiente", "receipt_exists": True},
         Role.OPERATIVO, "conciliado", 403),
        ({"obra_id": uuid4(), "estado": "pendiente", "receipt_exists": False},
         Role.ADMIN, "conciliado", 422),
        ({"obra_id": uuid4(), "estado": "conciliado", "receipt_exists": True},
         Role.ADMIN, "conciliado", 409),
        (None, Role.ADMIN, "conciliado", 404),
    ],
)
def test_update_income_status_guards(monkeypatch, row, role, state, expected):
    connection = _status_repo(monkeypatch, row)
    with pytest.raises(HTTPException) as error:
        repository.update_income_status(
            Settings(_env_file=None), UserContext(id=uuid4(), role=role), uuid4(),
            IncomeStatusUpdate.model_validate({"state": state}),
        )
    assert error.value.status_code == expected
    assert not any("update public.ingreso" in c.args[0] for c in connection.execute.call_args_list)


def test_update_income_status_reconciles_and_reverts(monkeypatch):
    user = UserContext(id=uuid4(), role=Role.ADMIN)
    connection = _status_repo(
        monkeypatch, {"obra_id": uuid4(), "estado": "pendiente", "receipt_exists": True}
    )
    repository.update_income_status(
        Settings(_env_file=None), user, uuid4(),
        IncomeStatusUpdate.model_validate({"state": "conciliado"}),
    )
    sql = [c.args[0] for c in connection.execute.call_args_list]
    assert "for update" in sql[0]
    assert any("estado = 'conciliado', conciliado_por" in q for q in sql)

    connection = _status_repo(
        monkeypatch, {"obra_id": uuid4(), "estado": "conciliado", "receipt_exists": True}
    )
    repository.update_income_status(
        Settings(_env_file=None), user, uuid4(),
        IncomeStatusUpdate.model_validate({"state": "pendiente", "reason": "Depósito duplicado"}),
    )
    calls = connection.execute.call_args_list
    [update] = [c for c in calls if "update public.ingreso" in c.args[0]]
    assert "conciliado_por = null" in update.args[0]
    assert update.args[1][0] == "Depósito duplicado"


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"concept": None},
        {"amount": "0"},
        {"amount": "-5"},
        {"amount": "0.00001"},
        {"amount": "100000000000000"},
        {"concept": "ab"},
        {"received_on": "2026-02-30"},
        {"state": "conciliado"},
        {"folio": "I-99999"},
    ],
)
def test_income_update_rejects_invalid_or_empty_changes(body):
    with pytest.raises(ValidationError):
        IncomeUpdate.model_validate(body)


def test_income_update_accepts_partial_changes():
    update = IncomeUpdate.model_validate({"concept": "  Estimación 2 ", "amount": "10.5"})
    assert update.concept == "Estimación 2" and update.amount == Decimal("10.5")
    assert update.model_fields_set == {"concept", "amount"}


def _edit_repo(monkeypatch, row):
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = row

    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    monkeypatch.setattr(repository, "require_work_access", lambda *args: None)
    monkeypatch.setattr(repository, "_income_detail", lambda *args: {"id": "ok"})
    return connection


def _current(state="conciliado"):
    return {
        "obra_id": uuid4(), "fecha": date(2026, 9, 1), "concepto": "Anticipo",
        "importe": Decimal("100.0000"), "estado": state,
    }


@pytest.mark.parametrize(("row", "role", "expected"), [
    (None, Role.ADMIN, 404), (_current(), Role.OPERATIVO, 403),
])
def test_update_income_guards(monkeypatch, row, role, expected):
    connection = _edit_repo(monkeypatch, row)
    with pytest.raises(HTTPException) as error:
        repository.update_income(
            Settings(_env_file=None), UserContext(id=uuid4(), role=role), uuid4(),
            IncomeUpdate.model_validate({"amount": "5"}),
        )
    assert error.value.status_code == expected
    assert not any("update public.ingreso" in c.args[0] for c in connection.execute.call_args_list)


@pytest.mark.parametrize("state", ["pendiente", "conciliado"])
def test_update_income_changes_only_what_differs_and_audits(monkeypatch, state):
    connection = _edit_repo(monkeypatch, _current(state))
    repository.update_income(
        Settings(_env_file=None), UserContext(id=uuid4(), role=Role.ADMIN), uuid4(),
        IncomeUpdate.model_validate({"concept": "Anticipo", "amount": "150.5"}),
    )
    calls = connection.execute.call_args_list
    assert "for update" in calls[0].args[0]
    [update] = [c for c in calls if "update public.ingreso" in c.args[0]]
    assert "importe = %(importe)s" in update.args[0] and "concepto" not in update.args[0]
    assert update.args[1]["importe"] == Decimal("150.5000")
    [audit] = [c for c in calls if "audit_log_negocio" in c.args[0]]
    detail = audit.args[1][3].obj
    assert detail == {
        "estado": state, "antes": {"importe": "100.0000"}, "despues": {"importe": "150.5000"},
    }


def test_update_income_without_real_changes_writes_nothing(monkeypatch):
    connection = _edit_repo(monkeypatch, _current())
    repository.update_income(
        Settings(_env_file=None), UserContext(id=uuid4(), role=Role.ADMIN), uuid4(),
        IncomeUpdate.model_validate({"concept": "Anticipo", "amount": "100"}),
    )
    sql = [c.args[0] for c in connection.execute.call_args_list]
    assert not any("update public.ingreso" in q or "audit_log_negocio" in q for q in sql)
