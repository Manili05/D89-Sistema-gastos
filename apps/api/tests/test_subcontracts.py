"""Cambio 9: subcontract (piecework) contracts and their estimations."""

import random
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
    EstimationCreate,
    EstimationKind,
    EstimationStatusUpdate,
    Role,
    SubcontractCreate,
    SubcontractUpdate,
    UserContext,
)
from app.services import repository
from app.services.estimation_totals import estimation_amounts, retention_for

D = Decimal
ADMIN = UserContext(id=uuid4(), role=Role.ADMIN)


# --- Money rules ---------------------------------------------------------------------

def test_net_equation_is_exact_for_many_amounts():
    rng = random.Random(89)
    for _ in range(2000):
        gross = D(rng.randint(1, 10_000_000)) / 100
        percent = D(rng.randint(0, 3000)) / 100
        additions = D(rng.randint(0, 50_000)) / 100
        retention = retention_for(EstimationKind.AVANCE, gross, percent)
        room = gross + additions - retention
        deductions = D(rng.randint(0, int(room * 50))) / 100
        amortization = D(rng.randint(0, int((room - deductions) * 100))) / 100
        amounts = estimation_amounts(
            EstimationKind.AVANCE, gross, percent,
            amortization=amortization, additions=additions, deductions=deductions,
        )
        assert amounts.net == gross + additions - deductions - amounts.retention - amortization
        assert amounts.net >= 0
        assert amounts.retention == amounts.retention.quantize(D("0.01"))


def test_worked_example():
    # 4,000 avance, 5 % garantía (200), +200 aditivas, −100 deductivas, −500 amortización.
    amounts = estimation_amounts(
        EstimationKind.AVANCE, D("4000"), D("5"),
        amortization=D("500"), additions=D("200"), deductions=D("100"),
    )
    assert (amounts.retention, amounts.net) == (D("200.00"), D("3400.00"))


@pytest.mark.parametrize(("gross", "percent", "retention"), [
    ("100.10", "5", "5.01"),      # 5.005 → HALF_UP
    ("100.30", "5", "5.02"),      # 5.015 → HALF_UP
    ("99.99", "0", "0.00"),
    ("1234.56", "10", "123.46"),  # 123.456
    ("0.01", "100", "0.01"),
])
def test_retention_rounds_half_up_to_cents(gross, percent, retention):
    assert retention_for(EstimationKind.AVANCE, D(gross), D(percent)) == D(retention)
    assert retention_for(EstimationKind.FINIQUITO, D(gross), D(percent)) == D(retention)


def test_advance_is_paid_in_full():
    amounts = estimation_amounts(EstimationKind.ANTICIPO, D("2500"), D("10"))
    assert (amounts.retention, amounts.net) == (D("0"), D("2500"))
    with pytest.raises(ValueError):
        estimation_amounts(EstimationKind.ANTICIPO, D("2500"), D("10"), amortization=D("1"))


def test_negative_net_is_rejected():
    with pytest.raises(ValueError, match="negativo"):
        estimation_amounts(EstimationKind.AVANCE, D("100"), D("10"), deductions=D("95"))


# --- Input models --------------------------------------------------------------------

def estimation(**changes):
    return {"estimated_on": "2026-10-01", "kind": "avance", "gross_amount": "1000", **changes}


@pytest.mark.parametrize("changes", [
    {"gross_amount": "0"},
    {"gross_amount": "10.001"},
    {"kind": "anticipo", "advance_amortization": "1"},
    {"kind": "anticipo", "additions": "1", "adjustment_notes": "Trabajo extra"},
    {"additions": "10"},                                  # no justification
    {"deductions": "10", "adjustment_notes": "mal"},      # too short
    {"deductions": "-1", "adjustment_notes": "Penalización"},
    {"retention_amount": "5"},                            # server-computed
    {"net_amount": "5"},                                  # server-computed
    {"kind": "estimacion"},
])
def test_estimation_input_rejections(changes):
    with pytest.raises(ValidationError):
        EstimationCreate.model_validate(estimation(**changes))


def test_estimation_input_accepts_justified_adjustments():
    value = EstimationCreate.model_validate(estimation(
        additions="150.50", deductions="20", adjustment_notes="  Muro extra; daño en puerta ",
    ))
    assert value.adjustment_notes == "Muro extra; daño en puerta"


def contract(**changes):
    return {"supplier_id": str(uuid4()), "expense_item_id": str(uuid4()),
            "expense_subitem_id": str(uuid4()), "description": "Colocación de block",
            "contracted_amount": "10000", **changes}


@pytest.mark.parametrize("changes", [
    {"contracted_amount": "0"}, {"contracted_amount": "1.001"},
    {"retention_percent": "100.01"}, {"retention_percent": "-1"},
    {"description": "ab"}, {"category_id": str(uuid4())}, {"folio": "SC-9999"},
])
def test_subcontract_input_rejections(changes):
    with pytest.raises(ValidationError):
        SubcontractCreate.model_validate(contract(**changes))


def test_subcontract_defaults_to_no_retention():
    assert SubcontractCreate.model_validate(contract()).retention_percent == D("0")


@pytest.mark.parametrize("body", [
    {}, {"state": "finiquitado"}, {"state": "activo"},
    {"expense_item_id": str(uuid4())},
])
def test_subcontract_update_rejections(body):
    with pytest.raises(ValidationError):
        SubcontractUpdate.model_validate(body)


def test_only_paying_is_a_status_change():
    assert EstimationStatusUpdate.model_validate({"state": "pagado"})
    with pytest.raises(ValidationError):
        EstimationStatusUpdate.model_validate({"state": "borrador"})


# --- Repository rules (mocked connection) --------------------------------------------

def _connection(contract_row, others, next_number=3):
    connection = MagicMock()

    def execute(sql, params=None):
        result = MagicMock()
        if "from public.subcontrato where id = %s for update" in sql:
            result.fetchone.return_value = contract_row
        elif "count(*) filter (where tipo = 'finiquito')" in sql:
            result.fetchone.return_value = others
        elif "estimaciones_emitidas + 1" in sql:
            result.fetchone.return_value = {"n": next_number}
        else:
            result.fetchone.return_value = {"id": uuid4()}
        return result

    connection.execute.side_effect = execute
    return connection


def _patch(monkeypatch, connection):
    @contextmanager
    def fake_transaction(settings):
        yield connection

    monkeypatch.setattr(repository, "transaction", fake_transaction)
    monkeypatch.setattr(repository, "require_work_access", lambda *args: None)
    monkeypatch.setattr(repository, "_estimation_detail", lambda *args: {"id": "ok"})


def _contract(state="activo", amount="10000", percent="5"):
    return {"id": uuid4(), "obra_id": uuid4(), "estado": state, "importe_contratado": D(amount),
            "fondo_garantia_pct": D(percent)}


def _others(gross="0", advances="0", advances_paid="0", amortized="0", finiquitos=0,
            retained_paid="0", refunds="0"):
    return {"gross": D(gross), "advances": D(advances), "advances_paid": D(advances_paid),
            "amortized": D(amortized), "finiquitos": finiquitos,
            "retained_paid": D(retained_paid), "refunds": D(refunds)}


def _insert(connection):
    [call] = [c for c in connection.execute.call_args_list
              if "insert into public.estimacion_subcontrato" in c.args[0]]
    return call.args[1]


def test_create_estimation_computes_retention_and_net(monkeypatch):
    connection = _connection(_contract(), _others(advances_paid="1000"))
    _patch(monkeypatch, connection)
    repository.create_estimation(
        Settings(_env_file=None), ADMIN, uuid4(), EstimationCreate.model_validate(estimation(
            gross_amount="4000", advance_amortization="500", additions="200",
            deductions="100", adjustment_notes="Extra y reparación",
        )),
    )
    params = _insert(connection)
    # numero, folio, fecha, tipo, bruto, amortización, retención, aditivas, deductivas, neto
    assert params[1:3] == (3, "EST-03")
    assert params[4:11] == ("avance", D("4000"), D("500"), D("200.00"), D("200"), D("100"),
                            D("3400.00"))


@pytest.mark.parametrize(("contract_row", "others", "body", "status_code"), [
    # The contract is the cap for avances/finiquito; extras go as aditivas.
    (_contract(amount="10000"), _others(gross="9000"), estimation(gross_amount="1000.01"), 422),
    (_contract(amount="10000"), _others(advances="9000"),
     estimation(kind="anticipo", gross_amount="1000.01"), 422),
    # Only paid advances can be amortized, never twice.
    (_contract(), _others(advances_paid="1000", amortized="800"),
     estimation(advance_amortization="200.01"), 422),
    (_contract(), _others(), estimation(advance_amortization="1"), 422),
    # The finiquito settles the whole pending advance and there is only one.
    (_contract(), _others(advances_paid="1000", amortized="600"),
     estimation(kind="finiquito", advance_amortization="300"), 422),
    (_contract(), _others(finiquitos=1), estimation(kind="finiquito"), 409),
    # Net can never be negative.
    (_contract(percent="10"), _others(),
     estimation(gross_amount="100", deductions="95", adjustment_notes="Penalización"), 422),
    # Settled or cancelled contracts take no more estimations.
    (_contract(state="finiquitado"), _others(), estimation(), 409),
    (_contract(state="cancelado"), _others(), estimation(), 409),
])
def test_create_estimation_rejections(monkeypatch, contract_row, others, body, status_code):
    connection = _connection(contract_row, others)
    _patch(monkeypatch, connection)
    with pytest.raises(HTTPException) as error:
        repository.create_estimation(
            Settings(_env_file=None), ADMIN, uuid4(), EstimationCreate.model_validate(body)
        )
    assert error.value.status_code == status_code
    assert not any("insert into" in c.args[0] for c in connection.execute.call_args_list)


def test_finiquito_amortizing_everything_is_accepted(monkeypatch):
    connection = _connection(_contract(percent="5"), _others(advances_paid="1000",
                                                             amortized="500", gross="4000"))
    _patch(monkeypatch, connection)
    repository.create_estimation(
        Settings(_env_file=None), ADMIN, uuid4(), EstimationCreate.model_validate(
            estimation(kind="finiquito", gross_amount="6000", advance_amortization="500")
        ),
    )
    assert _insert(connection)[4:11] == ("finiquito", D("6000"), D("500"), D("300.00"),
                                         D("0"), D("0"), D("5200.00"))


def test_operativo_cannot_write_even_calling_repository(monkeypatch):
    connection = _connection(_contract(), _others())
    _patch(monkeypatch, connection)
    operativo = UserContext(id=uuid4(), role=Role.OPERATIVO)
    with pytest.raises(HTTPException) as error:
        repository.create_estimation(
            Settings(_env_file=None), operativo, uuid4(),
            EstimationCreate.model_validate(estimation()),
        )
    assert error.value.status_code == 403
    with pytest.raises(HTTPException) as error:
        repository.create_subcontract(
            Settings(_env_file=None), operativo, uuid4(),
            SubcontractCreate.model_validate(contract()),
        )
    assert error.value.status_code == 403
    assert not any("insert into" in c.args[0] for c in connection.execute.call_args_list)


# --- Financial bridge: paying an estimation creates one validated expense ------------

def _pay_connection(contract_row, estimation_row, *, week_closed=False, other_drafts=False):
    connection = MagicMock()

    def execute(sql, params=None):
        result = MagicMock()
        if "from public.subcontrato where id = %s for update" in sql:
            result.fetchone.return_value = contract_row
        elif "select id, estado::text as estado, tipo::text as tipo" in sql:
            result.fetchone.return_value = {"id": uuid4(), "estado": "borrador",
                                            "tipo": estimation_row["tipo"]}
        elif "estado = 'borrador' and id <> %s" in sql:
            result.fetchone.return_value = {"x": 1} if other_drafts else None
        elif "as today" in sql:
            result.fetchone.return_value = {"today": date(2026, 9, 30)}
        elif "from public.cierre_semanal c" in sql:
            result.fetchone.return_value = {"locked": week_closed}
        elif "select folio, importe_neto, tipo::text as tipo" in sql:
            result.fetchone.return_value = estimation_row
        elif "insert into public.gasto (" in sql:
            result.fetchone.return_value = {"id": uuid4(), "folio": "G-00009"}
        else:
            result.fetchone.return_value = None
        return result

    connection.execute.side_effect = execute
    return connection


def _paying_contract():
    return {**_contract(), "folio": "SC-0007", "proveedor_id": uuid4(),
            "partida_gasto_id": uuid4(), "subpartida_gasto_id": uuid4(),
            "categoria_gasto_id": uuid4()}


def _calls(connection, fragment):
    return [c for c in connection.execute.call_args_list if fragment in c.args[0]]


def test_paying_an_estimation_inserts_exactly_one_validated_expense(monkeypatch):
    contract_row = _paying_contract()
    connection = _pay_connection(contract_row, {"folio": "EST-03", "importe_neto": D("3400.00"),
                                                "tipo": "avance"})
    _patch(monkeypatch, connection)
    estimation_id = uuid4()
    repository.pay_estimation(Settings(_env_file=None), ADMIN, contract_row["id"], estimation_id)

    [expense] = _calls(connection, "insert into public.gasto (")
    assert "'validado'" in expense.args[0] and "estimacion_subcontrato_id" in expense.args[0]
    concept = "Pago de Estimación EST-03 - Subcontrato SC-0007"
    assert expense.args[1] == (
        contract_row["obra_id"], contract_row["partida_gasto_id"],
        contract_row["subpartida_gasto_id"], contract_row["categoria_gasto_id"],
        contract_row["proveedor_id"], date(2026, 9, 30), concept, D("3400.00"), D("3400.00"),
        ADMIN.id, ADMIN.id, estimation_id,
    )
    [line] = _calls(connection, "insert into public.gasto_concepto")
    assert line.args[1][1:] == (concept, D("3400.00"), D("3400.00"))
    # Same transaction: the estimation is paid before its expense exists.
    sql = [c.args[0] for c in connection.execute.call_args_list]
    paid = next(i for i, q in enumerate(sql) if "set estado = 'pagado'" in q)
    inserted = next(i for i, q in enumerate(sql) if "insert into public.gasto (" in q)
    assert paid < inserted


@pytest.mark.parametrize(("kwargs", "status_code"), [
    ({"week_closed": True}, 409),       # the payment week is closed
    ({"other_drafts": True}, 409),      # finiquito with other drafts pending
])
def test_payment_rejections_create_no_expense(monkeypatch, kwargs, status_code):
    kind = "finiquito" if kwargs.get("other_drafts") else "avance"
    connection = _pay_connection(_paying_contract(), {"folio": "EST-03",
                                                      "importe_neto": D("10"), "tipo": kind},
                                 **kwargs)
    _patch(monkeypatch, connection)
    with pytest.raises(HTTPException) as error:
        repository.pay_estimation(Settings(_env_file=None), ADMIN, uuid4(), uuid4())
    assert error.value.status_code == status_code
    assert not _calls(connection, "insert into public.gasto")
    assert not _calls(connection, "set estado = 'pagado'")


def test_zero_net_estimation_moves_no_money(monkeypatch):
    connection = _pay_connection(_paying_contract(), {"folio": "EST-04",
                                                      "importe_neto": D("0"), "tipo": "avance"})
    _patch(monkeypatch, connection)
    repository.pay_estimation(Settings(_env_file=None), ADMIN, uuid4(), uuid4())
    assert _calls(connection, "set estado = 'pagado'")
    assert not _calls(connection, "insert into public.gasto")



# --- Retention fund refund (devolución de fondo de garantía) -------------------------

def refund(amount="300", **changes):
    return estimation(kind="devolucion_fondo", gross_amount=amount, **changes)


def test_refund_is_paid_in_full():
    amounts = estimation_amounts(EstimationKind.DEVOLUCION_FONDO, D("300"), D("5"))
    assert (amounts.retention, amounts.amortization, amounts.net) == (D("0"), D("0"), D("300"))
    for adjustment in ({"additions": "1", "adjustment_notes": "Extra"},
                       {"advance_amortization": "1"},
                       {"deductions": "1", "adjustment_notes": "Daño"}):
        with pytest.raises(ValidationError):
            EstimationCreate.model_validate(refund(**adjustment))


@pytest.mark.parametrize(("others", "amount", "status_code"), [
    (_others(retained_paid="500"), "500.01", 422),                   # more than withheld
    (_others(retained_paid="500", refunds="300"), "200.01", 422),    # drafts/paid refunds count
    (_others(), "0.01", 422),                                         # nothing withheld yet
])
def test_refund_cannot_exceed_the_withheld_fund(monkeypatch, others, amount, status_code):
    connection = _connection(_contract(state="finiquitado"), others)
    _patch(monkeypatch, connection)
    with pytest.raises(HTTPException) as error:
        repository.create_estimation(Settings(_env_file=None), ADMIN, uuid4(),
                                     EstimationCreate.model_validate(refund(amount)))
    assert error.value.status_code == status_code
    assert "fondo de garantía disponible" in error.value.detail
    assert not _calls(connection, "insert into")


@pytest.mark.parametrize("state", ["activo", "finiquitado", "cancelado"])
def test_refund_is_allowed_after_the_finiquito(monkeypatch, state):
    # Contract cap does not apply: the full contract was already estimated.
    connection = _connection(_contract(state=state, amount="10000"),
                             _others(gross="10000", retained_paid="500", refunds="300"))
    _patch(monkeypatch, connection)
    repository.create_estimation(Settings(_env_file=None), ADMIN, uuid4(),
                                 EstimationCreate.model_validate(refund("200")))
    assert _insert(connection)[4:11] == ("devolucion_fondo", D("200"), D("0"), D("0"), D("0"),
                                         D("0"), D("200"))


def test_other_estimations_still_need_an_active_contract(monkeypatch):
    connection = _connection(_contract(state="finiquitado"), _others(retained_paid="500"))
    _patch(monkeypatch, connection)
    with pytest.raises(HTTPException) as error:
        repository.create_estimation(Settings(_env_file=None), ADMIN, uuid4(),
                                     EstimationCreate.model_validate(estimation()))
    assert error.value.status_code == 409


def test_paying_a_refund_creates_its_validated_expense(monkeypatch):
    contract_row = {**_paying_contract(), "estado": "finiquitado"}
    connection = _pay_connection(contract_row, {"folio": "EST-05", "importe_neto": D("300"),
                                                "tipo": "devolucion_fondo"})
    _patch(monkeypatch, connection)
    repository.pay_estimation(Settings(_env_file=None), ADMIN, contract_row["id"], uuid4())
    [expense] = _calls(connection, "insert into public.gasto (")
    assert expense.args[1][6] == "Devolución de Fondo de Garantía EST-05 - Subcontrato SC-0007"
    assert expense.args[1][7] == D("300")
    # A refund does not settle anything: the contract state is untouched.
    assert not _calls(connection, "estado = 'finiquitado'")
