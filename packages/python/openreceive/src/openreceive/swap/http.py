"""The injectable HTTP transport the swap provider and rates feed call:
`http(method=, url=, headers=, body=, timeout_ms=) -> {"status": int, "body": str}`.
The default runs on httpx with explicit timeouts; tests inject a callable."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Protocol


class HttpTransport(Protocol):
    def __call__(
        self,
        *,
        method: str,
        url: str,
        headers: Mapping[str, str],
        body: str | None,
        timeout_ms: int | None,
    ) -> dict[str, Any]: ...


def default_http_request(
    *,
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: str | None = None,
    timeout_ms: int | None = None,
) -> dict[str, Any]:
    import httpx

    timeout = None if timeout_ms is None else timeout_ms / 1000.0
    with httpx.Client(timeout=timeout, follow_redirects=False) as client:
        response = client.request(
            method.upper(),
            url,
            headers=dict(headers),
            content=None if body is None else body.encode("utf-8"),
        )
    return {"status": response.status_code, "body": response.text}


def is_timeout_error(error: BaseException) -> bool:
    try:
        import httpx
    except ImportError:  # pragma: no cover
        httpx = None  # type: ignore[assignment]
    if httpx is not None and isinstance(error, httpx.TimeoutException):
        return True
    if isinstance(error, TimeoutError):
        return True
    return "abort" in str(error).lower() or "timed out" in str(error).lower()
