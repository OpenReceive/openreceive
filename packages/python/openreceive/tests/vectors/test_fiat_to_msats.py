from decimal import getcontext

import pytest

from openreceive import money
from tests.conftest import load_vector

VECTOR = load_vector("fiat-to-msats.usd.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_fiat_to_msats(case: dict) -> None:
    msats = money.quote_fiat_to_msats(case["fiat"]["value"], VECTOR["btc_fiat_price"])
    assert msats == case["expected"]["amount_msats"]
    assert msats // 1000 == case["expected"]["amount_sats"]


@pytest.mark.parametrize("case", VECTOR["invalid_cases"], ids=lambda case: case["name"])
def test_fiat_to_msats_refusals(case: dict) -> None:
    with pytest.raises((ValueError, TypeError)):
        money.quote_fiat_to_msats(case["fiat"]["value"], VECTOR["btc_fiat_price"])


def test_quote_ignores_the_global_decimal_context() -> None:
    # A web worker's global context may have been changed by another library;
    # the quote must not read it.
    saved = getcontext().prec
    getcontext().prec = 3
    try:
        assert money.quote_fiat_to_msats("1.23", "50000.00") == 2_460_000
    finally:
        getcontext().prec = saved


def test_direct_amounts() -> None:
    assert money.direct_to_msats("SATS", "1200") == 1_200_000
    assert money.direct_to_msats("BTC", "0.00001") == 1_000_000
    with pytest.raises(ValueError):
        money.direct_to_msats("SATS", "1.5")
    with pytest.raises(ValueError):
        money.direct_to_msats("EUR", "1")
