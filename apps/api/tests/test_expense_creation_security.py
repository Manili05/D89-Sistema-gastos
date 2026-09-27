from contextlib import contextmanager
from datetime import date
from decimal import Decimal
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.core.config import Settings
from app.models import ExpenseCreate, ExpenseUpdate, Role, UserContext
from app.services import repository


@pytest.mark.parametrize("role", [Role.ADMIN, Role.OPERATIVO])
@pytest.mark.parametrize("state", [None, "pendiente", "validado"])
def test_repository_ignores_client_state(monkeypatch, role, state):
    """Guard the actual INSERT argument, not only the input model's default."""
    supplier_id = uuid4()
    payload = {
        "work_id": uuid4(),
        "area_id": uuid4(),
        "expense_item_id": uuid4(),
        "expense_subitem_id": uuid4(),
        "expense_category_id": uuid4(),
        "supplier_id": supplier_id,
        "spent_on": "2026-09-27",
        "concept": "Security regression",
        "amount": "100.00",
    }
    if state is not None:
        payload["state"] = state
    connection = MagicMock()
    connection.execute.return_value.fetchone.return_value = {"id": supplier_id, "locked": False}

    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    monkeypatch.setattr(repository, "require_work_access", lambda *args: None)
    repository.create_expense(
        Settings(_env_file=None),
        UserContext(id=uuid4(), role=role),
        ExpenseCreate.model_validate(payload),
    )
    inserts = [
        call
        for call in connection.execute.call_args_list
        if "insert into public.gasto (" in call.args[0]
    ]
    assert len(inserts) == 1
    assert inserts[0].args[1][-2] == "pendiente"


def _closed_week_connection(closed: set[str], expense: dict | None = None) -> MagicMock:
    """Answer the ISO-week lock query from `closed` dates; record every statement."""
    connection = MagicMock()

    def execute(sql, params=None):
        result = MagicMock()
        if "from public.cierre_semanal c" in sql:
            result.fetchone.return_value = {"locked": str(params[1]) in closed}
        elif "from public.gasto where id" in sql:
            result.fetchone.return_value = expense
        else:
            result.fetchone.return_value = {"id": uuid4()}
        return result

    connection.execute.side_effect = execute
    return connection


def _patch_repository(monkeypatch, connection):
    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    monkeypatch.setattr(repository, "require_work_access", lambda *args: None)


def _writes(connection: MagicMock) -> list[str]:
    return [
        call.args[0]
        for call in connection.execute.call_args_list
        if any(verb in call.args[0].lower() for verb in ("insert into", "update public."))
    ]


def test_create_expense_in_closed_iso_week_is_rejected_before_insert(monkeypatch):
    connection = _closed_week_connection({"2026-09-21"})
    _patch_repository(monkeypatch, connection)
    payload = ExpenseCreate.model_validate(
        {
            "work_id": uuid4(),
            "area_id": uuid4(),
            "expense_item_id": uuid4(),
            "expense_subitem_id": uuid4(),
            "expense_category_id": uuid4(),
            "supplier_id": uuid4(),
            "spent_on": "2026-09-21",
            "concept": "Gasto en semana cerrada",
            "amount": "100.00",
        }
    )
    with pytest.raises(HTTPException) as error:
        repository.create_expense(
            Settings(_env_file=None), UserContext(id=uuid4(), role=Role.ADMIN), payload
        )
    assert error.value.status_code == 409
    assert _writes(connection) == []
    calls = connection.execute.call_args_list
    locks = [call for call in calls if "pg_advisory_xact_lock" in call.args[0]]
    assert locks, "the work advisory lock must serialize expense writes with closes"


def test_update_expense_into_closed_iso_week_is_rejected(monkeypatch):
    user = UserContext(id=uuid4(), role=Role.OPERATIVO)
    expense = {
        "obra_id": uuid4(),
        "estado": "pendiente",
        "creado_por": user.id,
        "fecha": date(2026, 9, 28),
    }
    connection = _closed_week_connection({"2026-09-21"}, expense)
    _patch_repository(monkeypatch, connection)
    payload = ExpenseUpdate(
        area_id=uuid4(),
        expense_item_id=uuid4(),
        expense_subitem_id=uuid4(),
        expense_category_id=uuid4(),
        supplier_id=uuid4(),
        spent_on=date(2026, 9, 21),
        concept="Mover a semana cerrada",
        amount=Decimal("50"),
    )
    with pytest.raises(HTTPException) as error:
        repository.update_expense(Settings(_env_file=None), user, uuid4(), payload)
    assert error.value.status_code == 409
    assert "destino" in error.value.detail
    assert _writes(connection) == []
