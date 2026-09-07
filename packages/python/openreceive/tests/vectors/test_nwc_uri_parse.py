import pytest

from openreceive.nwc.uri import NwcUriParseError, parse_uri
from tests.conftest import load_vector

VECTOR = load_vector("nwc-uri-parse.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_nwc_uri_parse(case: dict) -> None:
    if "expected_error" in case:
        with pytest.raises(NwcUriParseError) as raised:
            parse_uri(case["uri"])
        assert raised.value.code == case["expected_error"]
        return
    parsed = parse_uri(case["uri"])
    expected = case["expected"]
    assert parsed.wallet_pubkey == expected["wallet_pubkey"]
    assert list(parsed.relays) == expected["relays"]
    assert bool(parsed.client_secret) == expected["secret_present"]
    assert parsed.lud16 == expected.get("lud16")
    assert parsed.redacted == expected["redacted"]
    # The secret never appears in the connection's repr.
    assert parsed.client_secret not in repr(parsed)
