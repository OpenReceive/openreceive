import pytest

from openreceive import money
from tests.conftest import load_vector

VECTOR = load_vector("amount-boundaries.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_amount_boundaries(case: dict) -> None:
    try:
        money.bounded_msats(case["amount_msats"])
        valid = True
    except (ValueError, TypeError):
        valid = False
    assert valid == case["valid"]
