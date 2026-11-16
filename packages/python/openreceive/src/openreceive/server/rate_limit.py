"""The built-in per-IP invoice rate limiter: a COUNT over the engine-owned rows'
`client_ip` within the rolling window (on `inserted_at`), throttling only the
minting actions. OFF by default — shared-IP deployments (POS terminals, kiosks)
must never be throttled by accident. An address that cannot be a payer (the
host's own proxy or network) is never counted. Twin of the Rails
`resolved_rate_limit` (JS createIpRateLimit)."""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping
from typing import Any

from openreceive.server import client_ip as client_ip_module
from openreceive.server.errors import ConfigurationError, RateLimitedError
from openreceive.server.handler import HookContext
from openreceive.storage.repository import PaymentRepository

log = logging.getLogger("openreceive")

DEFAULT_RATE_LIMIT_PER_HOUR = 60
HOUR_SECONDS = 3_600
DAY_SECONDS = 86_400
BUILT_IN_RATE_LIMIT_MESSAGE = "Too many payment attempts. Please try again later."
MINTING_ACTIONS = ("checkout.create", "swap.create")
# A refusal names the refused address in the log at most this often.
REFUSAL_WARNING_SECONDS = 60


def _positive(value: object, name: str) -> int:
    limit = int(str(value))
    if limit <= 0:
        raise ConfigurationError(f"rate_limiting {name} must be a positive integer (got {limit}).")
    return limit


def built_in_rate_limit(
    repository: PaymentRepository,
    settings: bool | Mapping[str, Any],
    *,
    client_ip: Callable[[Any], str | None],
    clock: Callable[[], int] | None = None,
) -> Callable[[HookContext], bool]:
    """`settings` is True (60/hour) or {"limit_per_hour", "limit_per_day"?}.
    `client_ip` extracts the raw IP from the framework request; it is bucketed
    the same way the committed rows were stamped. No attributable IP fails
    open, warned once per process. A loopback or private address is the host's
    own proxy or network, never a payer: it is not counted, warned once per
    process. A refusal names the refused address in the log, at most once a
    minute."""
    options: Mapping[str, Any] = settings if isinstance(settings, Mapping) else {}
    limit_per_hour = _positive(
        options.get("limit_per_hour", DEFAULT_RATE_LIMIT_PER_HOUR), "limit_per_hour"
    )
    per_day = options.get("limit_per_day")
    limit_per_day = None if per_day is None else _positive(per_day, "limit_per_day")
    now: Callable[[], int] = clock or (lambda: int(time.time()))
    warned = {"unattributable": False, "not_a_payer": False}
    last_refusal_warning: int | None = None
    lock = threading.Lock()

    def once(name: str) -> bool:
        """True the first time `name` is asked for, False ever after."""
        with lock:
            first = not warned[name]
            warned[name] = True
        return first

    def refuse(ip: str, counted: int, limit: int, window: str, moment: int) -> RateLimitedError:
        # Say which address was refused, at most once a minute. When that
        # address is the host's own proxy, every payer shares its limit and this
        # line is the only place the operator can see why checkouts stopped.
        nonlocal last_refusal_warning
        with lock:
            due = (
                last_refusal_warning is None
                or moment - last_refusal_warning >= REFUSAL_WARNING_SECONDS
            )
            if due:
                last_refusal_warning = moment
        if due:
            log.warning(
                "[openreceive] rate limiting refused a new payment from %s: %s made in the last %s, "
                "limit %s. If %s is your proxy, load balancer or CDN rather than one payer, every "
                "payer is sharing this limit: pass the payer's own address — see "
                "https://openreceive.org/guides/rate-limiting.md",
                ip,
                counted,
                window,
                limit,
                ip,
            )
        return RateLimitedError(BUILT_IN_RATE_LIMIT_MESSAGE)

    def limiter(context: HookContext) -> bool:
        if context.action not in MINTING_ACTIONS:
            return True
        ip = client_ip_module.attributed(client_ip(context.request))
        if not ip:
            if once("unattributable"):
                log.warning(
                    "[openreceive] rate limiting is enabled but no client IP could be resolved; attempts from this "
                    "request are not counted. Configure client_ip. https://openreceive.org/guides/rate-limiting.md"
                )
            return True
        if not client_ip_module.is_payer_address(ip):
            # Counting it would put every payer in one bucket and stop the whole
            # site at the limit, so it is not counted.
            if once("not_a_payer"):
                log.warning(
                    "[openreceive] rate limiting is on, but this request's client address is %s, a "
                    "private or loopback address: your own proxy or network, not the payer. "
                    "Limiting it would make every payer share one limit, so the request was "
                    "allowed and such requests are not limited. Pass the payer's own address — "
                    "see https://openreceive.org/guides/rate-limiting.md",
                    ip,
                )
            return True
        moment = now()
        last_hour = repository.count_attempts_from_ip(ip, moment - HOUR_SECONDS)
        if last_hour >= limit_per_hour:
            raise refuse(ip, last_hour, limit_per_hour, "hour", moment)
        if limit_per_day is not None:
            last_day = repository.count_attempts_from_ip(ip, moment - DAY_SECONDS)
            if last_day >= limit_per_day:
                raise refuse(ip, last_day, limit_per_day, "24 hours", moment)
        return True

    return limiter
