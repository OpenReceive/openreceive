"""System checks: what `manage.py check` (and every `runserver` boot) says
about the install.

  openreceive.E001  OPENRECEIVE["HOST"] missing, unimportable or incomplete
  openreceive.W001  on_paid is the generated logging-only placeholder
  openreceive.W002  authorize is the generated allow-all placeholder
  openreceive.E002  the wallet preflight failed — run ONLY when
                    OPENRECEIVE_PREFLIGHT=1 is set (the deploy-time step:
                    `OPENRECEIVE_PREFLIGHT=1 manage.py check --deploy`), so an
                    ordinary `check` never opens a relay connection.
  openreceive.W003  DEBUG is on and the project's own
                    DEFAULT_EXCEPTION_REPORTER_FILTER does not hide NWC_URI /
                    LSC_URI_* (openreceive.django.debug)
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from typing import Any

from django.conf import settings
from django.core.checks import CheckMessage, Error, Warning, register
from django.core.exceptions import ImproperlyConfigured
from django.utils.module_loading import import_string

from openreceive.django import conf
from openreceive.django.debug import DJANGO_DEFAULT_FILTER, FILTER_PATH, hides_wallet_codes
from openreceive.server.errors import ConfigurationError
from openreceive.server.service import sanitize_failure_message

TAG = "openreceive"
PREFLIGHT_ENV = "OPENRECEIVE_PREFLIGHT"


@register(TAG)
def check_host(app_configs: Sequence[Any] | None, **kwargs: Any) -> list[CheckMessage]:
    messages: list[CheckMessage] = []
    try:
        config = conf.read_settings()
        host = conf.load_host(config)
    except ImproperlyConfigured as error:
        messages.append(
            Error(
                str(error),
                hint="Run `manage.py openreceive_install <app>` and add the printed settings.",
                id="openreceive.E001",
            )
        )
        return messages
    for line in host.placeholder_warnings():
        check_id = "openreceive.W001" if line.startswith("on_paid") else "openreceive.W002"
        messages.append(Warning(line, id=check_id))
    return messages


@register(TAG)
def check_wallet_preflight(app_configs: Sequence[Any] | None, **kwargs: Any) -> list[CheckMessage]:
    if (os.environ.get(PREFLIGHT_ENV) or "").strip().lower() not in ("1", "true", "yes"):
        return []
    try:
        service = conf.build_service()
    except (ConfigurationError, ImproperlyConfigured) as error:
        return [
            Error(
                sanitize_failure_message(error),
                hint="Fix NWC_URI / LSC_URI_* in the server environment; see the quickstart.",
                id="openreceive.E002",
            )
        ]
    except Exception as error:
        return [
            Error(
                f"Wallet preflight raised: {sanitize_failure_message(error)}",
                id="openreceive.E002",
            )
        ]
    closer = getattr(service.nwc_client, "close", None)
    if callable(closer):
        closer()
    return []


@register(TAG)
def check_debug_page_filter(app_configs: Sequence[Any] | None, **kwargs: Any) -> list[CheckMessage]:
    if not settings.DEBUG:
        return []
    path = str(getattr(settings, "DEFAULT_EXCEPTION_REPORTER_FILTER", DJANGO_DEFAULT_FILTER))
    try:
        filter_class = import_string(path)
    except ImportError:
        return []  # Django reports an unimportable setting itself.
    if hides_wallet_codes(filter_class):
        return []
    return [
        Warning(
            f"DEFAULT_EXCEPTION_REPORTER_FILTER ({path}) does not hide NWC_URI or LSC_URI_*: "
            "with DEBUG on, Django's error page would print the wallet codes in full.",
            hint=f"Subclass {FILTER_PATH}, or drop the setting so OpenReceive installs it.",
            id="openreceive.W003",
        )
    ]
