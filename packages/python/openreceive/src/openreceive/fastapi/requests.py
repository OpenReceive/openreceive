"""Starlette → the framework-free `HttpRequest`, and the engine's
`HttpResponse` → a Starlette `Response`. Nothing about the wire lives here:
the router hands the request over and the engine's own cross-site,
content-type, declared-fields and body-cap checks run unchanged.

The body is a READER, not bytes: the engine calls it only after a route
matched and the declared Content-Length passed the 64 KB cap, and the reader
stops one byte past the cap — an anonymous payer can never stream an
unbounded body into a worker thread. The endpoint is a sync `def` run in
Starlette's threadpool, so the reader hops back to the event loop with
`anyio.from_thread.run` to consume the ASGI stream.
"""

from __future__ import annotations

import anyio
from starlette.requests import Request
from starlette.responses import Response

from openreceive.server.handler import HttpRequest, HttpResponse

BODYLESS_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


async def read_bounded_body(request: Request, max_bytes: int) -> bytes:
    """At most `max_bytes` of the request body; the stream is abandoned one
    chunk past the cap rather than drained."""
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        if not chunk:
            continue
        chunks.append(chunk)
        size += len(chunk)
        if size > max_bytes:
            break
    return b"".join(chunks)[:max_bytes]


def http_request_from_starlette(request: Request, *, path: str) -> HttpRequest:
    """`path` is the engine-relative path (`/checkouts`, `/rates`): the router
    strips the mount prefix so the engine sees the same wire whatever prefix
    `include_router` was given. `framework_request` is the untouched Starlette
    request the host's `authorize` receives."""
    method = request.method.upper()
    declared = request.headers.get("content-length")
    content_length = int(declared) if declared is not None and declared.strip().isdigit() else None

    def read_body(max_bytes: int) -> bytes:
        return anyio.from_thread.run(read_bounded_body, request, max_bytes)

    return HttpRequest(
        method=method,
        path=path,
        query_string=request.url.query,
        headers=dict(request.headers.items()),
        body=None if method in BODYLESS_METHODS else read_body,
        content_length=content_length,
        remote_addr=request.client.host if request.client is not None else None,
        framework_request=request,
    )


def starlette_response(response: HttpResponse) -> Response:
    status, _body, headers = response
    return Response(
        content=response.json(),
        status_code=status,
        headers=dict(headers),
        media_type="application/json",
    )
