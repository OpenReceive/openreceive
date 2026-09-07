import pytest

from openreceive.nwc import requests
from tests.conftest import load_vector

VECTOR = load_vector("nwc-request-response.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_nwc_request_response(case: dict) -> None:
    if case["method"] == "make_invoice":
        assert (
            requests.make_invoice_request(case["openreceive_request"])
            == case["expected_nip47_request"]
        )
        if "expected_openreceive_response" in case:
            actual = requests.normalize_make_invoice_response(case["raw_response"])
            for key, value in case["expected_openreceive_response"].items():
                assert actual[key] == value, key
        return
    assert (
        requests.list_transactions_request(case["openreceive_request"])
        == case["expected_nip47_request"]
    )
    if "expected_openreceive_response" in case:
        actual = requests.normalize_list_transactions_response(case["raw_response"])
        expected = case["expected_openreceive_response"]
        assert len(actual["transactions"]) == len(expected["transactions"])
        for index, row in enumerate(expected["transactions"]):
            for key, value in row.items():
                assert actual["transactions"][index][key] == value, f"row {index} {key}"


def test_unrecognized_shape_fails_the_scan() -> None:
    with pytest.raises(ValueError):
        requests.normalize_list_transactions_response({"unexpected": "shape"})
    with pytest.raises(ValueError):
        requests.normalize_list_transactions_response({"transactions": [{"payment_hash": "bad"}]})


def test_empty_reply_is_an_empty_scan() -> None:
    assert requests.normalize_list_transactions_response({}) == {"transactions": []}
    assert requests.normalize_list_transactions_response(None) == {"transactions": []}
