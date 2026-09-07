"""The system checks: E001 for a missing/unimportable HOST, W001/W002 for the
generated placeholders, and E002 (the wallet preflight) only when
OPENRECEIVE_PREFLIGHT=1 is set."""

from __future__ import annotations

import pytest
from django.core.checks import run_checks
from django.test import override_settings

from openreceive.django import checks, conf
from openreceive.server import ALLOW_ALL_AUTHORIZE, LOGGING_ON_PAID


class PlaceholderHost:
    authorize = staticmethod(ALLOW_ALL_AUTHORIZE)
    on_paid = staticmethod(LOGGING_ON_PAID)

    def amount_for(self, reference: str) -> None:
        return None


def ids(messages: list) -> list[str]:  # type: ignore[type-arg]
    return sorted(str(message.id) for message in messages)


def test_a_clean_host_raises_nothing() -> None:
    assert run_checks(tags=[checks.TAG]) == []


@override_settings(OPENRECEIVE={})
def test_missing_host_is_e001() -> None:
    messages = run_checks(tags=[checks.TAG])
    assert ids(messages) == ["openreceive.E001"]
    assert "HOST" in messages[0].msg


@override_settings(OPENRECEIVE={"HOST": "tests.django.nope.Host"})
def test_unimportable_host_is_e001() -> None:
    assert ids(run_checks(tags=[checks.TAG])) == ["openreceive.E001"]


@override_settings(OPENRECEIVE={"HOST": "tests.django.host.Host", "RATE_LIMITNG": True})
def test_unknown_setting_key_is_e001() -> None:
    messages = run_checks(tags=[checks.TAG])
    assert ids(messages) == ["openreceive.E001"] and "RATE_LIMITNG" in messages[0].msg


@override_settings(OPENRECEIVE={"HOST": "tests.django.test_checks.PlaceholderHost"})
def test_placeholders_are_w001_and_w002() -> None:
    assert ids(run_checks(tags=[checks.TAG])) == ["openreceive.W001", "openreceive.W002"]


def test_wallet_preflight_runs_only_when_asked(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(checks.PREFLIGHT_ENV, raising=False)
    with override_settings(OPENRECEIVE={"HOST": "tests.django.host.Host"}):
        monkeypatch.delenv("NWC_URI", raising=False)
        assert run_checks(tags=[checks.TAG]) == []  # no relay, no env var: silent
        monkeypatch.setenv(checks.PREFLIGHT_ENV, "1")
        messages = run_checks(tags=[checks.TAG])
        assert ids(messages) == ["openreceive.E002"] and "NWC_URI is not set" in messages[0].msg
    # The test settings' SERVICE factory builds over the fakes: preflight passes.
    monkeypatch.setenv(checks.PREFLIGHT_ENV, "1")
    assert run_checks(tags=[checks.TAG]) == []
    conf.reset()
