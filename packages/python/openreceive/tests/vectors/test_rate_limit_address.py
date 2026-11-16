"""The per-IP limit never counts a proxy's or the host's own address: every
case of the shared family, on the raw value and on the bucket the limiter
counts, which must classify the same."""

from typing import Any

import pytest

from openreceive.server import client_ip
from tests.conftest import load_vector

VECTOR = load_vector("rate-limit-address.json")


def test_the_family_is_not_empty() -> None:
    assert len(VECTOR["cases"]) > 30


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_rate_limit_address(case: dict[str, Any]) -> None:
    expected = case["expected"]["payer"]
    assert client_ip.is_payer_address(case["address"]) is expected
    assert client_ip.is_payer_address(client_ip.bucket(case["address"])) is expected, "bucketed"
