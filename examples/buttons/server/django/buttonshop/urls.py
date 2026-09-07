"""Every route this host serves. OpenReceive owns exactly one include."""

from __future__ import annotations

from django.urls import include, path, re_path

from buttonshop import testkit, views
from buttonshop.shop import urls as shop_urls

UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

urlpatterns = [
    # The engine. One include is the whole of what the browser packages need to
    # reach every OpenReceive route; the SPA hydrates the prefix from the
    # bootstrap payload rather than keeping a second copy of this string.
    path("openreceive/", include("openreceive.django.urls")),
    # The shop's own JSON API. OpenReceive owns none of it.
    path("shop/", include(shop_urls)),
    # The one copy of the artwork, at examples/buttons/images.
    re_path(r"^images/(?P<name>openreceive-[a-z-]+\.webp)$", views.artwork, name="artwork"),
    # The test-only control surface: declared unconditionally, refuses
    # unconditionally unless DEMO_WALLET=testkit (buttonshop/testkit.py).
    re_path(r"^__testkit/(?P<action>[a-z-]*)$", testkit.control, name="testkit"),
    path("__testkit", testkit.control),
    # The SPA shell, in production (in development Vite serves it). The
    # checkout's own URL renders the SAME shell: the client reads the uuid off
    # location.pathname and asks the shop for the order.
    path("", views.spa, name="spa"),
    re_path(rf"^checkout/(?P<reference>{UUID})$", views.spa, name="spa-checkout"),
]
