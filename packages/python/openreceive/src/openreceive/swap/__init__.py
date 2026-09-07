"""Automated swaps: the FixedFloat(-compatible) provider, the asset catalog,
rates/limits caching, and the LSC connection factories."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from openreceive.swap import lsc_uri
from openreceive.swap.fixedfloat import (
    FixedFloatApiError,
    FixedFloatProvider,
    availability_message,
    classify_quote_error,
)
from openreceive.swap.http import HttpTransport


def providers_from_connections(
    connections: list[dict[str, Any]],
    *,
    http: HttpTransport | None = None,
    now: Callable[[], int] | None = None,
) -> list[FixedFloatProvider]:
    return [
        FixedFloatProvider(
            id=connection["provider_id"],
            base_url=connection["base_url"],
            key=connection["key"],
            secret=connection["secret"],
            http=http,
            now=now,
        )
        for connection in connections
    ]


def providers_from_environment(
    env: Mapping[str, str],
    *,
    http: HttpTransport | None = None,
    now: Callable[[], int] | None = None,
) -> list[FixedFloatProvider]:
    """LSC_URI_PRIMARY first, LSC_URI_BACKUP second — the failover order."""
    return providers_from_connections(lsc_uri.read_environment(env), http=http, now=now)


__all__ = [
    "FixedFloatApiError",
    "FixedFloatProvider",
    "availability_message",
    "classify_quote_error",
    "providers_from_connections",
    "providers_from_environment",
]
