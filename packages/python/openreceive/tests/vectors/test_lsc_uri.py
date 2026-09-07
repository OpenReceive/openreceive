import pytest

from openreceive.swap import lsc_uri
from tests.conftest import load_vector

VECTOR = load_vector("lsc-uri.json")


@pytest.mark.parametrize("case", VECTOR["valid"], ids=lambda case: case["name"])
def test_lsc_uri_valid(case: dict) -> None:
    assert lsc_uri.parse(case["uri"]) == case["expected"]


@pytest.mark.parametrize("case", VECTOR["invalid"], ids=lambda case: case["name"])
def test_lsc_uri_invalid(case: dict) -> None:
    with pytest.raises(lsc_uri.LscUriError):
        lsc_uri.parse(case["uri"])


def test_environment_order_and_duplicate_ids() -> None:
    primary = VECTOR["valid"][0]["uri"]
    backup = VECTOR["valid"][1]["uri"]
    connections = lsc_uri.read_environment({"LSC_URI_PRIMARY": primary, "LSC_URI_BACKUP": backup})
    assert [c["provider_id"] for c in connections] == ["ff-example", "swap-example-v1"]
    with pytest.raises(lsc_uri.LscUriError, match="LSC_URI_BACKUP"):
        lsc_uri.read_environment({"LSC_URI_PRIMARY": primary, "LSC_URI_BACKUP": primary})
    assert lsc_uri.read_environment({}) == []
