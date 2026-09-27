from contextlib import contextmanager
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

from app.core.config import Settings
from app.models import ExpenseCreate, Role, UserContext
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
    connection.execute.return_value.fetchone.return_value = {"id": supplier_id}

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
