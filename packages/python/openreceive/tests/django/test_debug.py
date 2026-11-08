"""DEBUG's error page never prints the wallet codes. `manage.py runserver`
copies the process environment into request.META, and Django's own filter
hides only API|AUTH|TOKEN|KEY|SECRET|PASS|SIGNATURE names: NWC_URI and
LSC_URI_* match none of them. The app installs a filter that does, unless the
project chose its own (then check openreceive.W003 speaks up)."""

from __future__ import annotations

import sys

from django.conf import settings
from django.test import RequestFactory, override_settings
from django.views.debug import technical_500_response

from openreceive.django import checks
from openreceive.django.debug import (
    DJANGO_DEFAULT_FILTER,
    FILTER_PATH,
    OpenReceiveExceptionReporterFilter,
    install_default_filter,
)

NWC_SECRET = "9f1c" * 16
LSC_SECRET = "lscsecretlscsecret"
ENVIRONMENT = {
    "NWC_URI": f"nostr+walletconnect://{'ab' * 32}?relay=wss://relay.example&secret={NWC_SECRET}",
    "LSC_URI_PRIMARY": f"lightning+swapconnect://ff.io/?key=lsckey&secret={LSC_SECRET}",
    "LSC_URI_BACKUP": f"lightning+swapconnect://backup.example/?key=k2&secret={LSC_SECRET}2",
    "SOME_SETTING": "visible",
}


def debug_page() -> str:
    """The trial probe's render: runserver's META, then the technical 500
    page through the project's configured filter, with the environment also
    held by a frame (as `os.environ` is in the frames that read it)."""
    request = RequestFactory().get("/", **ENVIRONMENT)
    environment = dict(ENVIRONMENT)  # a frame local the page lists
    assert environment
    try:
        raise RuntimeError("openreceive debug probe")
    except RuntimeError:
        return technical_500_response(request, *sys.exc_info()).content.decode()


def test_the_app_installs_its_filter_when_the_project_set_none() -> None:
    assert settings.DEFAULT_EXCEPTION_REPORTER_FILTER == FILTER_PATH


def test_the_debug_page_hides_the_codes_by_name_and_by_value() -> None:
    page = debug_page()
    for secret in (NWC_SECRET, LSC_SECRET, "lsckey"):
        assert secret not in page
    assert "NWC_URI" in page and "LSC_URI_PRIMARY" in page  # named, value starred
    assert "visible" in page  # everything else stays readable


def test_the_filter_hides_a_uri_under_any_name() -> None:
    reporter = OpenReceiveExceptionReporterFilter()
    hidden = reporter.cleansed_substitute
    assert reporter.cleanse_setting("WALLET", ENVIRONMENT["NWC_URI"]) == hidden
    assert reporter.cleanse_setting("PROVIDERS", [ENVIRONMENT["LSC_URI_PRIMARY"]]) == [hidden]
    assert reporter.cleanse_setting("OPENRECEIVE", {"HOST": "shop.Host"}) == {"HOST": "shop.Host"}


def test_without_the_filter_the_page_would_print_them() -> None:
    # The bug this fixes, so the probe above cannot pass for the wrong reason.
    from django.views import debug

    with override_settings(DEFAULT_EXCEPTION_REPORTER_FILTER=DJANGO_DEFAULT_FILTER):
        debug.get_default_exception_reporter_filter.cache_clear()
        try:
            assert NWC_SECRET in debug_page()
        finally:
            debug.get_default_exception_reporter_filter.cache_clear()


def test_a_project_filter_is_left_alone_and_w003_names_the_gap() -> None:
    from django.views import debug

    with override_settings(DEFAULT_EXCEPTION_REPORTER_FILTER=DJANGO_DEFAULT_FILTER, DEBUG=True):
        assert install_default_filter() is False
        assert settings.DEFAULT_EXCEPTION_REPORTER_FILTER == DJANGO_DEFAULT_FILTER
        warnings = checks.check_debug_page_filter(None)
        assert [warning.id for warning in warnings] == ["openreceive.W003"]
        assert "NWC_URI" in warnings[0].msg
    with override_settings(DEBUG=False, DEFAULT_EXCEPTION_REPORTER_FILTER=DJANGO_DEFAULT_FILTER):
        assert checks.check_debug_page_filter(None) == []
    with override_settings(DEBUG=True):
        assert checks.check_debug_page_filter(None) == []
    debug.get_default_exception_reporter_filter.cache_clear()
