import pytest

from openreceive.nwc.errors import WalletError, normalize_wallet_error
from tests.conftest import load_vector

VECTOR = load_vector("error-normalization.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_error_normalization(case: dict) -> None:
    actual = normalize_wallet_error(case["raw_error"])
    for key, value in case["expected"].items():
        assert actual.get(key) == value, key


def test_python_exceptions_normalize_by_class_name_and_cause() -> None:
    class Nip47NetworkError(Exception):
        pass

    try:
        try:
            raise Nip47NetworkError("relay closed")
        except Nip47NetworkError as inner:
            raise RuntimeError("wrapped") from inner
    except RuntimeError as outer:
        normalized = normalize_wallet_error(outer)
    assert normalized["code"] == "WALLET_UNAVAILABLE"
    assert normalized["retryable"] is True
    assert normalized["message"] == "wrapped"

    wallet = normalize_wallet_error(WalletError("RATE_LIMITED", "slow down"))
    assert wallet == {"code": "RATE_LIMITED", "message": "slow down", "retryable": True}
