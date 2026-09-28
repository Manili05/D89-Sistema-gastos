"""Header totals for a multi-line expense (prices captured WITH IVA included).

Pure functions shared by create and update. The server always derives line
amounts, subtotal, IVA and total; client-sent totals are never trusted.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Protocol

IVA_TASA_GENERAL = Decimal("0.16")
CENT = Decimal("0.01")


class ExpenseTotalsError(ValueError):
    pass


class LineInput(Protocol):
    quantity: Decimal
    unit_price: Decimal
    discount: Decimal


@dataclass(frozen=True)
class ExpenseTotals:
    line_amounts: tuple[Decimal, ...]
    amount: Decimal  # total final (con IVA) = Σ importes de concepto
    subtotal: Decimal
    iva: Decimal


def money(value: Decimal) -> Decimal:
    # HALF_UP matches PostgreSQL round() for the non-negative amounts stored here.
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def line_amount(line: LineInput) -> Decimal:
    gross = line.quantity * line.unit_price
    if line.discount > gross:
        raise ExpenseTotalsError("El descuento no puede superar cantidad × precio unitario")
    return money(gross - line.discount)


def max_included_iva(amount: Decimal) -> Decimal:
    """IVA contained in a total at the general 16 % rate."""
    return amount - money(amount / (1 + IVA_TASA_GENERAL))


def compute_totals(lines: list[LineInput], iva: Decimal | None = None) -> ExpenseTotals:
    """Prices include IVA: total = Σ lines. Without explicit IVA, 16 % is assumed.

    An explicit IVA (exempt items, 8 % border zone, mixed tickets) must lie between 0
    and the IVA a 16 % rate would contain, with one cent of rounding tolerance.
    """
    if not lines:
        raise ExpenseTotalsError("El gasto debe tener al menos un concepto")
    amounts = tuple(line_amount(line) for line in lines)
    amount = sum(amounts, Decimal(0))
    if amount <= 0:
        raise ExpenseTotalsError("El total del gasto debe ser mayor que cero")
    if iva is None:
        subtotal = money(amount / (1 + IVA_TASA_GENERAL))
        return ExpenseTotals(amounts, amount, subtotal, amount - subtotal)
    iva = money(iva)
    if iva < 0 or iva > max_included_iva(amount) + CENT:
        raise ExpenseTotalsError(
            f"El IVA debe estar entre 0 y {max_included_iva(amount)} "
            "(16 % incluido en el total)"
        )
    return ExpenseTotals(amounts, amount, amount - iva, iva)
