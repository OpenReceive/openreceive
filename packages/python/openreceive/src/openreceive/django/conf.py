"""`settings.OPENRECEIVE` → one lazily built `OpenReceiveApp` per process.

    OPENRECEIVE = {
        "HOST": "shop.openreceive_host.Host",   # dotted path: a class (or instance)
                                               # with amount_for / authorize / on_paid
                                               # (+ optional after_paid)
        "PRICE_CURRENCIES": ["USD"],
        "RATE_LIMITING": False,                # True, or {"limit_per_hour": …, "limit_per_day": …}
        "OPPORTUNISTIC_RECONCILE": True,       # False, or {"min_interval_seconds": …}
        "DATABASE": "default",                 # the DATABASES alias holding the two tables
        "SERVICE": None,                       # advanced: dotted path to a callable(env) -> Service
    }

A dotted path rather than a callable in settings: cache-safe, `manage.py check`
friendly, the AUTH_USER_MODEL idiom. Secrets (`NWC_URI`, `LSC_URI_PRIMARY`,
`LSC_URI_BACKUP`) come from `os.environ` — Django loads no .env file.

The app (and with it the wallet client and its receive-only preflight) is
built on the FIRST REQUEST, never at import or in `AppConfig.ready()`: those
run for `migrate`, `collectstatic` and shells on boxes with no relay access.
`manage.py check --deploy` with `OPENRECEIVE_PREFLIGHT=1` is the deploy-time
probe (openreceive.django.checks), `manage.py openreceive_doctor` the human one.
"""

from __future__ import annotations

import logging
import os
import threading
import traceback
from collections.abc import Callable, Mapping
from typing import Any

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.utils.module_loading import import_string

from openreceive.django.repository import DjangoPaymentRepository
from openreceive.server import Host, OpenReceiveApp, Service
from openreceive.server.errors import ConfigurationError
from openreceive.server.service import sanitize_failure_message

log = logging.getLogger("openreceive")

SETTING_NAME = "OPENRECEIVE"
DEFAULTS: dict[str, Any] = {
    "HOST": None,
    "PRICE_CURRENCIES": ["USD"],
    "RATE_LIMITING": False,
    "OPPORTUNISTIC_RECONCILE": True,
    "DATABASE": "default",
    "SERVICE": None,
}
HOST_METHODS = ("amount_for", "authorize", "on_paid")
QUICKSTART_URL = "https://openreceive.org/guides/quickstart-django.md"
NWC_URI_MISSING = (
    "NWC_URI is not set in this process's environment. OpenReceive reads os.environ, and Django "
    "loads no .env file on its own — export it, or have your process manager inject it. Get a "
    "receive-only NWC code here: https://openreceive.org/get_a_nwc_code_to_receive_payments"
)

_lock = threading.Lock()
_app: OpenReceiveApp | None = None


def read_settings() -> dict[str, Any]:
    """The OPENRECEIVE dict with defaults applied; an unknown key is a typo
    worth stopping on (a misspelled RATE_LIMITING silently leaving the
    limiter off is exactly the failure this refuses)."""
    configured = getattr(settings, SETTING_NAME, None) or {}
    if not isinstance(configured, Mapping):
        raise ImproperlyConfigured(f"settings.{SETTING_NAME} must be a dict. {QUICKSTART_URL}")
    unknown = sorted(set(configured) - set(DEFAULTS))
    if unknown:
        raise ImproperlyConfigured(
            f"settings.{SETTING_NAME} has unknown key(s): {', '.join(unknown)}. "
            f"Known keys: {', '.join(DEFAULTS)}. {QUICKSTART_URL}"
        )
    merged = dict(DEFAULTS)
    merged.update(configured)
    return merged


def load_host(config: Mapping[str, Any] | None = None) -> Host:
    """`HOST` → the engine's `Host` dataclass. The dotted path names a class
    (instantiated with no arguments) or a ready object; either exposes the
    three methods and optionally `after_paid`. Placeholder detection works
    through `staticmethod(LOGGING_ON_PAID)` etc. because the bound attribute
    IS the engine's function."""
    config = read_settings() if config is None else config
    dotted = config.get("HOST")
    if not dotted or not isinstance(dotted, str):
        raise ImproperlyConfigured(
            f'settings.{SETTING_NAME}["HOST"] is required: the dotted path of the class holding '
            f"amount_for, authorize and on_paid (run `manage.py openreceive_install <app>`). {QUICKSTART_URL}"
        )
    try:
        target = import_string(dotted)
    except ImportError as error:
        raise ImproperlyConfigured(
            f'settings.{SETTING_NAME}["HOST"] = {dotted!r} cannot be imported: {error}'
        ) from error
    instance = target() if isinstance(target, type) else target
    missing = [name for name in HOST_METHODS if not callable(getattr(instance, name, None))]
    if missing:
        raise ImproperlyConfigured(
            f"{dotted} is missing {', '.join(missing)}: the host needs amount_for, authorize and on_paid. "
            f"{QUICKSTART_URL}"
        )
    after_paid = getattr(instance, "after_paid", None)
    return Host(
        amount_for=instance.amount_for,
        authorize=instance.authorize,
        on_paid=instance.on_paid,
        after_paid=after_paid if callable(after_paid) else None,
    )


def build_service(
    config: Mapping[str, Any] | None = None, env: Mapping[str, str] | None = None
) -> Service:
    """The Service — and with it the fail-closed wallet preflight. `SERVICE`
    is the advanced seam for hosts that bring their own NWC client, price feed
    or providers (the demos' testkit mode uses it)."""
    config = read_settings() if config is None else config
    environment: Mapping[str, str] = os.environ if env is None else env
    factory_path = config.get("SERVICE")
    if factory_path:
        factory: Callable[[Mapping[str, str]], Service] = import_string(str(factory_path))
        return factory(environment)
    uri = (environment.get("NWC_URI") or "").strip()
    if not uri:
        raise ConfigurationError(NWC_URI_MISSING)
    from openreceive.nwc.receive_client import NwcReceiveClient

    client = NwcReceiveClient(uri)
    return Service(
        client,
        price_currencies=list(config.get("PRICE_CURRENCIES") or ["USD"]),
        env=environment,
        logger=log,
    )


def client_ip(request: Any) -> str | None:
    """REMOTE_ADDR after the host's own proxy handling (a trusted-proxy
    middleware that rewrites it runs first). Bucketed by the engine."""
    meta = getattr(request, "META", None)
    if not isinstance(meta, Mapping):
        return None
    value = meta.get("REMOTE_ADDR")
    return str(value) if value else None


def report_unexpected_error(error: BaseException, request_id: str) -> None:
    """An unexpected exception became an opaque 500 on the wire; log the class,
    the sanitized message and the frames — never the raw message, which can
    quote an NWC URI inside a connect error."""
    frames = "".join(traceback.format_tb(error.__traceback__)) if error.__traceback__ else ""
    log.error(
        "[openreceive] request %s failed: %s\n%s",
        request_id,
        sanitize_failure_message(error),
        frames.rstrip(),
    )


def build_app(
    config: Mapping[str, Any] | None = None, env: Mapping[str, str] | None = None
) -> OpenReceiveApp:
    config = read_settings() if config is None else config
    host = load_host(config)
    service = build_service(config, env)
    repository = DjangoPaymentRepository(using=str(config.get("DATABASE") or "default"))
    return OpenReceiveApp(
        service=service,
        host=host,
        repository=repository,
        rate_limiting=config.get("RATE_LIMITING") or False,
        client_ip=client_ip,
        opportunistic_reconcile=config.get("OPPORTUNISTIC_RECONCILE", True),
        report_unexpected_error=report_unexpected_error,
    )


def get_app() -> OpenReceiveApp:
    """The process-wide app, built on first use under a lock so concurrent
    first requests preflight the wallet once."""
    global _app
    app = _app
    if app is not None:
        return app
    with _lock:
        if _app is None:
            _app = build_app()
        return _app


def reset() -> None:
    """Forget the built app (tests, and `override_settings` boundaries)."""
    global _app
    with _lock:
        _app = None
