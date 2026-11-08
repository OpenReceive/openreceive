"""Django's DEBUG error page, without the wallet codes.

`manage.py runserver` copies the process environment into `request.META`, and
the technical 500 page lists META, the settings and every frame's local
variables. Django's `SafeExceptionReporterFilter` hides only names matching
API|AUTH|TOKEN|KEY|SECRET|PASS|SIGNATURE: `NWC_URI`, `LSC_URI_PRIMARY` and
`LSC_URI_BACKUP` match none of them, so any unhandled exception with DEBUG on
would print the receive code and the provider key and secret in the browser.

`OpenReceiveExceptionReporterFilter` also hides every NWC/LSC name, and any
value that quotes a `nostr+walletconnect:` or `lightning+swapconnect:` URI
whatever it is called (`os.environ` in a frame, a settings dict). The app
installs it as `DEFAULT_EXCEPTION_REPORTER_FILTER` when the project has not set
that setting itself (`OpenReceiveConfig.ready`); a project with its own filter
subclasses this one, and system check openreceive.W003 says so when it does not.
"""

from __future__ import annotations

import re
from typing import Any

from django.conf import settings
from django.views.debug import SafeExceptionReporterFilter, get_default_exception_reporter_filter

DJANGO_DEFAULT_FILTER = "django.views.debug.SafeExceptionReporterFilter"
FILTER_PATH = "openreceive.django.debug.OpenReceiveExceptionReporterFilter"
SETTING = "DEFAULT_EXCEPTION_REPORTER_FILTER"
# Django's names, plus OpenReceive's own secret environment names.
HIDDEN_NAMES = re.compile(
    SafeExceptionReporterFilter.hidden_settings.pattern + "|NWC|LSC_URI", flags=re.I
)
SECRET_URI = re.compile(r"nostr\+walletconnect:|lightning\+swapconnect:", flags=re.I)


def quotes_secret_uri(value: Any) -> bool:
    try:
        return SECRET_URI.search(value if isinstance(value, str) else repr(value)) is not None
    except Exception:
        return False


class OpenReceiveExceptionReporterFilter(SafeExceptionReporterFilter):
    hidden_settings = HIDDEN_NAMES

    def cleanse_setting(self, key: Any, value: Any) -> Any:
        cleansed = super().cleanse_setting(key, value)
        if isinstance(cleansed, str) and quotes_secret_uri(cleansed):
            return self.cleansed_substitute
        return cleansed

    def get_traceback_frame_variables(self, request: Any, tb_frame: Any) -> Any:
        return [
            (name, self.cleansed_substitute if quotes_secret_uri(value) else value)
            for name, value in super().get_traceback_frame_variables(request, tb_frame)
        ]


def hides_wallet_codes(filter_class: type) -> bool:
    """Whether a filter hides NWC_URI and LSC_URI_PRIMARY in request.META."""
    try:
        instance = filter_class()
        probe = "nostr+walletconnect://probe?secret=probe"
        return bool(
            instance.cleanse_setting("NWC_URI", probe) != probe
            and instance.cleanse_setting("LSC_URI_PRIMARY", probe) != probe
        )
    except Exception:
        return False


def install_default_filter() -> bool:
    """Make this filter the project's default unless the project chose one.
    True when it was installed."""
    if settings.is_overridden(SETTING):
        return False
    if getattr(settings, SETTING, DJANGO_DEFAULT_FILTER) != DJANGO_DEFAULT_FILTER:
        return False
    setattr(settings, SETTING, FILTER_PATH)
    # Django caches the default filter instance (functools.lru_cache) on first use.
    cache_clear = getattr(get_default_exception_reporter_filter, "cache_clear", None)
    if callable(cache_clear):
        cache_clear()
    return True
