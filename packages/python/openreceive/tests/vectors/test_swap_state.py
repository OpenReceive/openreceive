import pytest

from openreceive.swap.fixedfloat import FixedFloatProvider
from tests.conftest import load_vector

VECTOR = load_vector("swap-state.json")


def test_provider_name() -> None:
    assert VECTOR["provider"] == "fixedfloat"


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_swap_state(case: dict) -> None:
    # Through the production provider's normalizer (the same one get_status
    # runs), which interprets the generated decision table.
    actual = FixedFloatProvider.normalize_status(
        case["status"],
        case.get("emergency", {}),
        "refund-tx" if case["refund_tx_present"] else None,
    )
    assert actual == case["expected"]
