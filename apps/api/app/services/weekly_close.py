from dataclasses import dataclass, replace
from datetime import UTC, datetime
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


def close_week(
    work_id: UUID,
    iso_year: int,
    iso_week: int,
    admin_id: UUID,
    expenses: tuple[CloseExpenseSnapshot, ...],
) -> WeeklyClose:
    if not 1 <= iso_week <= 53:
        raise ValueError("semana ISO inválida")
    if not expenses:
        raise ValueError("el cierre debe incluir al menos un gasto")
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
