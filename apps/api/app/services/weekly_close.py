from dataclasses import dataclass, replace
from datetime import UTC, date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import UUID, uuid4


class CloseState(StrEnum):
    CLOSED = "cerrado"
    REOPENED = "reabierto"


@dataclass(frozen=True)
class CloseExpenseSnapshot:
    expense_id: UUID
    amount: Decimal
    state: str


@dataclass(frozen=True)
class WeeklyClose:
    id: UUID
    work_id: UUID
    iso_year: int
    iso_week: int
    state: CloseState
    closed_by: UUID
    closed_at: datetime
    expenses: tuple[CloseExpenseSnapshot, ...]
    reopened_by: UUID | None = None
    reopened_at: datetime | None = None
    reopen_reason: str | None = None
    revision: int = 1
    previous: "WeeklyClose | None" = None


def close_week(
    work_id: UUID,
    iso_year: int,
    iso_week: int,
    admin_id: UUID,
    expenses: tuple[CloseExpenseSnapshot, ...],
) -> WeeklyClose:
    try:
        date.fromisocalendar(iso_year, iso_week, 1)
    except ValueError as exc:
        raise ValueError("semana ISO inválida") from exc
    if any(expense.state != "validado" for expense in expenses):
        raise ValueError("el cierre sólo incluye gastos validados")
    return WeeklyClose(
        id=uuid4(),
        work_id=work_id,
        iso_year=iso_year,
        iso_week=iso_week,
        state=CloseState.CLOSED,
        closed_by=admin_id,
        closed_at=datetime.now(UTC),
        expenses=expenses,
    )


def reopen_week(close: WeeklyClose, admin_id: UUID, reason: str) -> WeeklyClose:
    normalized_reason = reason.strip()
    if close.state is not CloseState.CLOSED:
        raise ValueError("solo se puede reabrir un cierre cerrado")
    if len(normalized_reason) < 10:
        raise ValueError("el motivo de reapertura debe ser explícito")
    return replace(
        close,
        state=CloseState.REOPENED,
        reopened_by=admin_id,
        reopened_at=datetime.now(UTC),
        reopen_reason=normalized_reason,
    )


def reclose_week(
    close: WeeklyClose, admin_id: UUID, expenses: tuple[CloseExpenseSnapshot, ...]
) -> WeeklyClose:
    if close.state is not CloseState.REOPENED:
        raise ValueError("solo se puede volver a cerrar una semana reabierta")
    next_close = close_week(close.work_id, close.iso_year, close.iso_week, admin_id, expenses)
    return replace(next_close, id=close.id, revision=close.revision + 1, previous=close)
