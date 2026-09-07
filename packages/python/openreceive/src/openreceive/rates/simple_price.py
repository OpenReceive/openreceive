"""A Simple Price compatible HTTP endpoint on the httpx sync client with an
explicit timeout: a slow endpoint fails within the window so the cached feed
can fall through to the next provider."""

from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any, Protocol

from openreceive import rates


class HttpGet(Protocol):
    def __call__(
        self, url: str, headers: Mapping[str, str], timeout_ms: int | None
    ) -> dict[str, Any]: ...


def default_http_get(
    url: str, headers: Mapping[str, str], timeout_ms: int | None
) -> dict[str, Any]:
    import httpx

    timeout = None if timeout_ms is None else timeout_ms / 1000.0
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        response = client.get(url, headers=dict(headers))
    return {"status": response.status_code, "body": response.text}


class HttpSimplePriceProvider:
    def __init__(
        self, *, url: str, source: str, http: HttpGet | None = None, timeout_ms: int | None = None
    ) -> None:
        self.url = url
        self.source = source
        self.timeout_ms = timeout_ms
        self._http: HttpGet = http or default_http_get

    def btc_fiat_rates(self, currencies: list[str]) -> dict[str, Any]:
        return rates.parse_simple_price_response(self._fetch_json(), currencies)

    def all_btc_fiat_rates(self) -> dict[str, Any]:
        """Every well-formed currency the endpoint carries, for caching the
        whole feed in one read."""
        return rates.parse_available_simple_price_response(self._fetch_json())

    def _fetch_json(self) -> Any:
        response = self._perform_request()
        status = int(response["status"])
        if not 200 <= status <= 299:
            raise rates.PriceFeedError(f"price source {self.source} returned HTTP {status}")
        return json.loads(str(response.get("body") or ""))

    def _perform_request(self) -> dict[str, Any]:
        try:
            return self._http(self.url, {"accept": "application/json"}, self.timeout_ms)
        except rates.PriceFeedError:
            raise
        except Exception as error:
            from openreceive.swap.http import is_timeout_error

            if is_timeout_error(error) and self.timeout_ms is not None:
                raise rates.PriceFeedError(
                    f"price source {self.source} did not respond within {self.timeout_ms}ms"
                ) from error
            raise rates.PriceFeedError(
                f"price source {self.source} request failed: {error}"
            ) from error
