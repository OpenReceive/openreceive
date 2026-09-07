import pytest

from openreceive import settlement
from tests.conftest import load_vector

VECTOR = load_vector("settlement-detection.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_settlement_detection(case: dict) -> None:
    assert settlement.is_settled(case["transaction"]) == case["expected"]["settled"]
    if "status" in case["expected"]:
        assert settlement.status(case["transaction"]) == case["expected"]["status"]
