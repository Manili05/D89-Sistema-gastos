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


def _receipt_connection(expense: dict, stored: bool) -> MagicMock:
    connection = MagicMock()

    def execute(sql, params=None):
        result = MagicMock()
        if "from public.gasto where id" in sql:
            result.fetchone.return_value = expense
        elif "from storage.objects" in sql:
            result.fetchone.return_value = {"receipt_exists": stored}
        elif "from public.cierre_semanal c" in sql:
            result.fetchone.return_value = {"locked": False}
        else:
            result.fetchone.return_value = {"id": params[-1], "comprobante_path": params[0]}
        return result

    connection.execute.side_effect = execute
    return connection


@pytest.mark.parametrize("stored", [False, True])
def test_attach_receipt_requires_object_in_storage(monkeypatch, stored):
    user = UserContext(id=uuid4(), role=Role.OPERATIVO)
    work_id, expense_id = uuid4(), uuid4()
    expense = {
        "obra_id": work_id,
        "creado_por": user.id,
        "fecha": date(2026, 9, 28),
        "estado": "pendiente",
    }
    connection = _receipt_connection(expense, stored)
    _patch_repository(monkeypatch, connection)
    path = f"{work_id}/{expense_id}/1-ticket.png"
    if stored:
        row = repository.attach_receipt(Settings(_env_file=None), user, expense_id, path)
        assert row["comprobante_path"] == path
        assert len(_writes(connection)) == 1
    else:
        with pytest.raises(HTTPException) as error:
            repository.attach_receipt(Settings(_env_file=None), user, expense_id, path)
        assert error.value.status_code == 422
        assert error.value.detail == "El comprobante no existe en Storage"
        assert _writes(connection) == []
    lookups = [
        call for call in connection.execute.call_args_list if "storage.objects" in call.args[0]
    ]
    assert [call.args[1] for call in lookups] == [(path,)]


def test_unified_form_payload_cannot_choose_expense_state(monkeypatch):
    """The unified form no longer sends `state`; a forged one is still ignored."""
    connection = _closed_week_connection(set())
    _patch_repository(monkeypatch, connection)
    payload = ExpenseCreate.model_validate(
        {
            "work_id": uuid4(),
            "area_id": uuid4(),
            "expense_item_id": uuid4(),
            "expense_subitem_id": uuid4(),
            "expense_category_id": uuid4(),
            "budget_item_id": None,
            "supplier_id": uuid4(),
            "spent_on": "2026-09-28",
            "concept": "Formulario unificado",
            "folio": None,
            "amount": "250.00",
            "state": "validado",
        }
    )
    repository.create_expense(
        Settings(_env_file=None), UserContext(id=uuid4(), role=Role.ADMIN), payload
    )
    inserts = [sql for sql in _writes(connection) if "insert into public.gasto (" in sql]
    assert len(inserts) == 1
    insert_call = next(
        call
        for call in connection.execute.call_args_list
        if "insert into public.gasto (" in call.args[0]
    )
    assert insert_call.args[1][-2] == "pendiente"
