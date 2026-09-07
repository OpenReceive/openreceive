"""Who this browser is: a SIGNED cookie holding a ShopUser id, and nothing else.

SIGNED, always — Django's `set_signed_cookie` / `get_signed_cookie` under the
project SECRET_KEY. This value is the ownership token for every order this
browser ever placed: it gates the download, and it is what `authorize` checks
before OpenReceive will mint an invoice. A tampered value, or a raw uuid copied
out of the public feed, fails the signature and reads as ABSENT — the same
branch as no cookie at all, which is what keeps a bad value from being a 500.

Resolved by the SHOP views only, never by a health check, an asset or the
public feed: minting a visitor row for every crawler hit is a junk-row
generator, and the row is only meaningful on a route that can place an order.
"""

from __future__ import annotations

from django.http import HttpRequest, HttpResponse
from django.utils import timezone

from buttonshop.shop.models import ShopUser

COOKIE = "shop_user_id"
SALT = "buttonshop.shop_user_id"
# One year, rewritten on every shop request — which is what makes it ROLLING.
LIFETIME_SECONDS = 365 * 24 * 60 * 60


def visitor_id_from(request: HttpRequest) -> str | None:
    """The visitor's private id WITHOUT minting one. This is what `authorize`
    reads: an engine request carrying no valid cookie is a 403, not a new
    customer."""
    try:
        value = request.get_signed_cookie(COOKIE, default=None, salt=SALT, max_age=LIFETIME_SECONDS)
    except Exception:
        return None
    return str(value) if value else None


def resolve_visitor(request: HttpRequest) -> ShopUser:
    """The visitor, minting a row the first time this browser is seen. A
    cookie that outlives its row degrades to a NEW visitor, not a 500."""
    visitor_id = visitor_id_from(request)
    user = ShopUser.objects.filter(pk=visitor_id).first() if visitor_id else None
    if user is None:
        now = timezone.now()
        user = ShopUser.objects.create(first_seen_at=now, last_seen_at=now)
    else:
        user.touch_seen()
    return user


def attach_identity(response: HttpResponse, user: ShopUser, request: HttpRequest) -> HttpResponse:
    """`secure` follows THE REQUEST, not the environment: behind TLS the cookie
    is marked secure; the plain-http local run still gets a cookie."""
    response.set_signed_cookie(
        COOKIE,
        str(user.pk),
        salt=SALT,
        max_age=LIFETIME_SECONDS,
        httponly=True,
        samesite="Lax",
        secure=request.is_secure(),
        path="/",
    )
    return response
