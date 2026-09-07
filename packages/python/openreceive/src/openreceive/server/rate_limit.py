"""The built-in per-IP invoice rate limiter: a COUNT over the engine-owned rows'
`client_ip` within the rolling window (on `inserted_at`), throttling only the
minting actions. OFF by default — shared-IP deployments (POS terminals, kiosks)
must never be throttled by accident. Twin of the Rails `resolved_rate_limit`."""

from __future__ import annotations

import logging
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
    open, warned once per process."""
    options: Mapping[str, Any] = settings if isinstance(settings, Mapping) else {}
    limit_per_hour = _positive(
        options.get("limit_per_hour", DEFAULT_RATE_LIMIT_PER_HOUR), "limit_per_hour"
    )
    per_day = options.get("limit_per_day")
    limit_per_day = None if per_day is None else _positive(per_day, "limit_per_day")
    now: Callable[[], int] = clock or (lambda: int(time.time()))
    warned = {"unattributable": False}

    def limiter(context: HookContext) -> bool:
        if context.action not in MINTING_ACTIONS:
            return True
        ip = client_ip_module.attributed(client_ip(context.request))
        if not ip:
            if not warned["unattributable"]:
                warned["unattributable"] = True
                log.warning(
                    "[openreceive] rate limiting is enabled but no client IP could be resolved; attempts from this "
                    "request are not counted. Configure client_ip. https://openreceive.org/guides/rate-limiting.md"
                )
            return True
        moment = now()
        if repository.count_attempts_from_ip(ip, moment - HOUR_SECONDS) >= limit_per_hour:
            raise RateLimitedError(BUILT_IN_RATE_LIMIT_MESSAGE)
        if (
            limit_per_day is not None
            and repository.count_attempts_from_ip(ip, moment - DAY_SECONDS) >= limit_per_day
        ):
            raise RateLimitedError(BUILT_IN_RATE_LIMIT_MESSAGE)
        return True

    return limiter
