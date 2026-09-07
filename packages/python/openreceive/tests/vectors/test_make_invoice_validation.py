import pytest

from openreceive.nwc import requests
from tests.conftest import load_vector

VECTOR = load_vector("make-invoice-validation.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_make_invoice_validation(case: dict) -> None:
    request = dict(case["request"])
    # The vector encodes oversized metadata by note length instead of inlining
    # kilobytes of JSON.
    if "metadata_note_length" in request:
        request["metadata"] = {"note": "x" * request.pop("metadata_note_length")}
    try:
        requests.make_invoice_request(request)
        valid = True
    except (ValueError, KeyError, TypeError):
        valid = False
    assert valid == case["expected"]["valid"]
