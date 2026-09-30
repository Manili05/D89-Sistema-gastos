from dataclasses import dataclass
from decimal import Decimal

import pytest

from app.services.expense_totals import (
    ExpenseTotalsError,
    compute_totals,
    line_amount,
    max_included_iva,
)


@dataclass
class Line:
    quantity: Decimal
    unit_price: Decimal
    discount: Decimal = Decimal(0)


def L(q: str, p: str, d: str = "0") -> Line:  # noqa: N802 - short test builder
    return Line(Decimal(q), Decimal(p), Decimal(d))


def test_default_rule_assumes_prices_include_16_percent_iva():
    totals = compute_totals([L("10", "100"), L("1", "250.50", "0.50")])
    assert totals.line_amounts == (Decimal("1000.00"), Decimal("250.00"))
    assert totals.amount == Decimal("1250.00")
    assert totals.subtotal == Decimal("1077.59")  # 1250 / 1.16 = 1077.586…
    assert totals.iva == Decimal("172.41")
    assert totals.subtotal + totals.iva == totals.amount


def test_explicit_iva_is_respected_within_the_16_percent_ceiling():
    exempt = compute_totals([L("1", "116")], iva=Decimal("0"))
    assert (exempt.subtotal, exempt.iva) == (Decimal("116.00"), Decimal("0.00"))
    border = compute_totals([L("1", "108")], iva=Decimal("8"))  # 8 % frontera
    assert (border.subtotal, border.iva) == (Decimal("100.00"), Decimal("8.00"))
    ceiling = compute_totals([L("1", "116")], iva=Decimal("16"))
    assert ceiling.subtotal == Decimal("100.00")


@pytest.mark.parametrize("iva", ["16.02", "-0.01", "500"])
def test_explicit_iva_outside_the_allowed_range_is_rejected(iva):
    with pytest.raises(ExpenseTotalsError, match="IVA"):
        compute_totals([L("1", "116")], iva=Decimal(iva))


def test_rounding_is_half_up_per_line_like_postgres_round():
    # 3 × 0.335 = 1.005 → 1.01 (HALF_UP); HALF_EVEN would give 1.00.
    assert line_amount(L("3", "0.335")) == Decimal("1.01")
    assert line_amount(L("0.5", "0.01")) == Decimal("0.01")


def test_discount_cannot_exceed_the_gross_line_amount():
    assert line_amount(L("2", "50", "100")) == Decimal("0.00")
    with pytest.raises(ExpenseTotalsError, match="descuento"):
        line_amount(L("2", "50", "100.01"))


@pytest.mark.parametrize("lines", [[], [L("1", "0")], [L("1", "10", "10")]])
def test_expense_needs_lines_and_a_positive_total(lines):
    with pytest.raises(ExpenseTotalsError):
        compute_totals(lines)


def test_subtotal_plus_iva_always_equals_total_across_many_amounts():
    for cents in range(1, 5000, 7):
        amount = Decimal(cents) / 100
        totals = compute_totals([L("1", str(amount))])
        assert totals.subtotal + totals.iva == totals.amount
        assert Decimal(0) <= totals.iva <= max_included_iva(totals.amount)


def test_explicit_iva_tolerance_grows_one_cent_per_line_for_cfdi_rounding():
    # Three lines of $1.16: the 16 % contained in $3.48 is 0.48, but a CFDI that rounds
    # IVA per concept can report 3 × 0.16 = 0.48… plus up to a cent per line.
    lines = [L("1", "1.16")] * 3
    assert compute_totals(lines, iva=Decimal("0.51")).iva == Decimal("0.51")  # +3 cents
    with pytest.raises(ExpenseTotalsError):
        compute_totals(lines, iva=Decimal("0.52"))  # beyond one cent per line
    with pytest.raises(ExpenseTotalsError):
        compute_totals([L("1", "1.16")], iva=Decimal("0.18"))  # single line: ±1 cent only
