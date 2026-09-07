import re

import pytest

from openreceive.nwc.info import summarize
from tests.conftest import load_vector

VECTOR = load_vector("nwc-info.json")


@pytest.mark.parametrize("case", VECTOR["cases"], ids=lambda case: case["name"])
def test_nwc_info(case: dict) -> None:
    summary = summarize(case["raw_info"])
    expected = case["expected"]
    assert summary["methods"] == expected["methods"]
    assert summary["encryption"] == expected["encryption"]
    assert summary["spend_capability_advertised"] == expected["spend_capability_advertised"]
    assert summary["receive_checkout_ready"] == expected["receive_checkout_ready"]
    # Same extraction the JS and Ruby tests use: the warned method name is
    # quoted inside each warning message.
    warned = [
        match.group(1)
        for match in (re.search(r"'([^']+)'", warning) for warning in summary["warnings"])
        if match is not None
    ]
    assert warned == expected["warning_methods"]
