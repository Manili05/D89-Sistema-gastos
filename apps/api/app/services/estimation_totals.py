"""Exact money rules of a subcontract estimation (Cambio 9).

    neto = bruto + aditivas − deductivas − retención − amortización

The retention (fondo de garantía) is computed here from the contract percentage over
the gross amount of avances and finiquito, rounded HALF_UP to cents; an anticipo and a
devolución de fondo are paid in full (net = gross). The database repeats the equation
as a CHECK constraint.
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from app.models import EstimationKind

CENT = Decimal("0.01")
ZERO = Decimal("0")


@dataclass(frozen=True)
class EstimationAmounts:
    gross: Decimal
    additions: Decimal
    deductions: Decimal
    retention: Decimal
    amortization: Decimal
    net: Decimal


def retention_for(kind: EstimationKind, gross: Decimal, percent: Decimal) -> Decimal:
    if kind in (EstimationKind.ANTICIPO, EstimationKind.DEVOLUCION_FONDO):
        return ZERO
    return (gross * percent / Decimal("100")).quantize(CENT, rounding=ROUND_HALF_UP)


def estimation_amounts(
    kind: EstimationKind,
    gross: Decimal,
    retention_percent: Decimal,
    *,
    amortization: Decimal = ZERO,
    additions: Decimal = ZERO,
    deductions: Decimal = ZERO,
) -> EstimationAmounts:
    """Compute retention and net; raise ValueError when the net would be negative."""
    if kind in (EstimationKind.ANTICIPO, EstimationKind.DEVOLUCION_FONDO) and (
        amortization or additions or deductions
    ):
        raise ValueError(
            "Un anticipo o una devolución de fondo no lleva amortización, aditivas ni deductivas"
        )
    for value in (gross, amortization, additions, deductions, retention_percent):
        if value < 0:
            raise ValueError("Los importes no pueden ser negativos")
    retention = retention_for(kind, gross, retention_percent)
    net = gross + additions - deductions - retention - amortization
    if net < 0:
        raise ValueError(
            f"El importe neto sería negativo ({net}): revisa deductivas y amortización"
        )
    return EstimationAmounts(
        gross=gross, additions=additions, deductions=deductions,
        retention=retention, amortization=amortization, net=net,
    )
