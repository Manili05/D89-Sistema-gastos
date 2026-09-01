from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum


class TrafficLight(StrEnum):
    GREEN = "verde"
    AMBER = "ambar"
    RED = "rojo"


@dataclass(frozen=True)
class VariationResult:
    budget: Decimal
    actual: Decimal
    difference: Decimal
    percent: Decimal
    traffic_light: TrafficLight


def calculate_variation(
    budget: Decimal,
    actual: Decimal,
    green_threshold: Decimal = Decimal("10"),
    amber_threshold: Decimal = Decimal("25"),
) -> VariationResult:
    difference = actual - budget
    percent = Decimal("0") if budget == 0 and actual == 0 else (
        Decimal("100") if budget == 0 else difference / budget * Decimal("100")
    )
    overrun = max(percent, Decimal("0"))
    if overrun < green_threshold:
        traffic_light = TrafficLight.GREEN
    elif overrun <= amber_threshold:
        traffic_light = TrafficLight.AMBER
    else:
        traffic_light = TrafficLight.RED
    return VariationResult(budget, actual, difference, percent, traffic_light)
