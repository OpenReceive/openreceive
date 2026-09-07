"""The two non-shop views: the SPA shell and the artwork."""

from __future__ import annotations

from django.conf import settings
from django.http import FileResponse, Http404, HttpRequest, HttpResponse


def spa(request: HttpRequest, reference: str | None = None) -> HttpResponse:
    """dist/index.html, read on every request and never cached: it names the
    current bundle hashes, and a cached copy leaves browsers on a dead bundle
    after a deploy. In development Vite serves this page itself."""
    index = settings.DIST_DIR / "index.html"
    if not index.is_file():
        return HttpResponse(
            "The client bundle has not been built. Run `npm run build -w "
            "@openreceive/example-buttons-django`, or use the Vite dev server (`npm run dev`).",
            status=503,
            content_type="text/plain",
        )
    response = HttpResponse(index.read_bytes(), content_type="text/html; charset=utf-8")
    response["Cache-Control"] = "no-store"
    return response


def artwork(request: HttpRequest, name: str) -> HttpResponse:
    """examples/buttons/images/<name>. The URL pattern already pins the name to
    `openreceive-<sku>-button.webp`, so nothing here can walk out of the
    directory. Downloads of PAID artwork go through the shop route, not here —
    this serves the catalog thumbnails everyone sees."""
    path = settings.IMAGES_DIR / name
    if not path.is_file():
        raise Http404
    response = FileResponse(path.open("rb"), content_type="image/webp")
    response["Cache-Control"] = "public, max-age=86400"
    return response
