"""The shop's own JSON API. OpenReceive owns none of it: it never sees an
order, a cart, a price, a product or a download. The SPA talks to these
routes for everything except the payment itself, which goes to the mounted
engine at /openreceive."""

from __future__ import annotations

import json
from typing import Any

from django.conf import settings
from django.http import FileResponse, HttpRequest, HttpResponse, JsonResponse
from django.urls import reverse
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_GET, require_POST

from buttonshop.shop.identity import attach_identity, resolve_visitor
from buttonshop.shop.models import (
    CURRENCY,
    MAX_PER_SKU,
    ShopOrder,
    ShopOrderItem,
    ShopProduct,
    format_amount,
)


def image_url(image_name: str | None) -> str | None:
    return None if not image_name else f"/images/{image_name}"


def openreceive_prefix() -> str:
    """buttonshop/urls.py owns the mount path; the client hydrates it from the
    bootstrap payload rather than keeping a second copy."""
    return reverse("openreceive:rates")[: -len("/rates")]


def error(message: str, status: int = 422) -> JsonResponse:
    return JsonResponse({"error": message}, status=status)


# ------------------------------------------------------------------ bootstrap


@require_GET
@ensure_csrf_cookie
def bootstrap(request: HttpRequest) -> HttpResponse:
    """What the SPA hydrates from: the catalog with its image urls, the engine
    mount prefix, and this visitor's PUBLIC uuid. `ensure_csrf_cookie` sets
    the `csrftoken` cookie the client reads into <meta name="csrf-token"> —
    the one page-level thing a Django host does that a template-rendered
    page would do with {{ csrf_token }}."""
    user = resolve_visitor(request)
    payload = {
        "shop": {
            "currency": CURRENCY,
            "max_per_sku": MAX_PER_SKU,
            "openreceive_prefix": openreceive_prefix(),
            # The catalog ships FROM THE SERVER because the prices are ours:
            # the browser must not be allowed to supply a price or an image url.
            "catalog": [
                {
                    "sku": product.sku,
                    "name": product.name,
                    "price_cents": product.price_cents,
                    "image_url": image_url(product.image_name) or "",
                }
                for product in ShopProduct.objects.filter(active=True)
            ],
            # The public handle only. The private id stays in the signed cookie.
            "visitor": {"public_ref": str(user.public_ref)},
        }
    }
    response = JsonResponse(payload)
    response["Cache-Control"] = "no-store"
    return attach_identity(response, user, request)


# --------------------------------------------------------------- create order


def normalized_lines(requested: object) -> list[tuple[ShopProduct, int]]:
    """THE TRUST BOUNDARY. The cart is a list of claims. Only the SKU and the
    quantity survive: each SKU is looked up in the active catalog and the
    price comes from that row, never from the request. An unknown or
    deactivated SKU is DROPPED rather than rejecting the whole request,
    quantities are coerced and clamped, duplicate lines merge, and the result
    is re-emitted in catalog order."""
    if not isinstance(requested, list):
        return []
    quantities: dict[str, int] = {}
    for line in requested:
        if not isinstance(line, dict):
            continue
        product = ShopProduct.active_by_sku(line.get("sku"))
        if product is None:
            continue
        try:
            quantity = int(line.get("quantity", 0))
        except (TypeError, ValueError):
            continue
        if quantity <= 0:
            continue
        quantities[product.sku] = min(quantities.get(product.sku, 0) + quantity, MAX_PER_SKU)
    if not quantities:
        return []
    return [
        (product, quantities[product.sku])
        for product in ShopProduct.objects.filter(active=True, sku__in=list(quantities))
    ]


@require_POST
def create_order(request: HttpRequest) -> HttpResponse:
    """One cart becomes one order becomes one reference. The reference has to
    exist BEFORE checkout and survive every retry, so it is minted here, once,
    and the browser holds it. A fresh id per attempt would leave one cart
    payable twice."""
    user = resolve_visitor(request)
    try:
        body = json.loads(request.body or b"{}")
    except ValueError:
        body = {}
    lines = normalized_lines(body.get("items") if isinstance(body, dict) else None)
    if not lines:
        return attach_identity(error("Your cart is empty."), user, request)
    order = ShopOrder.create_from_lines(lines, shop_user=user)
    return attach_identity(JsonResponse(order_payload(order), status=201), user, request)


# ---------------------------------------------------------------- show order


def authorized_order(request: HttpRequest, reference: str, user: Any) -> ShopOrder | None:
    """Possession of an order id is a CLAIM, not proof — the same rule the
    engine's `authorize` applies. Another visitor's order is 404 and never
    403: do not confirm that an id exists."""
    order = ShopOrder.find_by_reference(reference)
    if order is None or order.shop_user_id != user.pk:
        return None
    return order


@require_GET
def show_order(request: HttpRequest, reference: str) -> HttpResponse:
    """The order as THIS browser is allowed to see it. The SPA polls this after
    settlement to learn the downloads have unlocked; `state` flips only in
    `on_paid`."""
    user = resolve_visitor(request)
    order = authorized_order(request, reference, user)
    if order is None:
        return attach_identity(error("Not found.", 404), user, request)
    response = JsonResponse(order_payload(order))
    response["Cache-Control"] = "no-store"
    return attach_identity(response, user, request)


@require_GET
def download(request: HttpRequest, reference: str, sku: str) -> HttpResponse:
    """The thing that was bought. Fulfillment is gated on the ORDER ROW, not
    on anything the browser says: `paid` is written inside OpenReceive's
    settlement transaction and nowhere else."""
    user = resolve_visitor(request)
    order = authorized_order(request, reference, user)
    if order is None:
        return attach_identity(error("Not found.", 404), user, request)
    if not order.paid:
        return attach_identity(error("Not paid.", 403), user, request)
    item = order.items.filter(sku=sku).first()
    if item is None:
        return attach_identity(error("Not found.", 404), user, request)
    # basename: the name comes from a database column, and a value with a path
    # separator must not be able to walk out of the artwork directory.
    path = settings.IMAGES_DIR / item.image_name.rsplit("/", 1)[-1]
    if not path.is_file():
        return attach_identity(error("Not found.", 404), user, request)
    response = FileResponse(path.open("rb"), as_attachment=True, filename=path.name)
    response["Content-Type"] = "image/webp"
    return attach_identity(response, user, request)


# -------------------------------------------------------------- recent orders


@require_GET
def recent_orders(request: HttpRequest) -> HttpResponse:
    """Public, unauthenticated, paid orders only. NO VISITOR IS MINTED HERE.
    Paid-only is also the anti-spam design: anyone can POST an order as many
    times as they like; a feed that showed unpaid ones would be a free
    billboard. An entry here costs a real payment."""
    orders = ShopOrder.recent_paid()
    response = JsonResponse(
        {"orders": [feed_payload(order) for order in orders], "totals": ShopOrder.feed_totals()}
    )
    # Public and identical for everyone, so it caches. That is only true
    # because there is no per-visitor field in the body — the SPA draws its
    # own "You" badge by comparing each row's buyer against the bootstrap.
    response["Cache-Control"] = "public, max-age=10"
    return response


# ------------------------------------------------------------------ payloads


def download_path(order: ShopOrder, item: ShopOrderItem) -> str:
    return reverse("shop-order-download", kwargs={"reference": str(order.pk), "sku": item.sku})


def order_payload(order: ShopOrder) -> dict[str, Any]:
    """The PRIVATE order payload. It carries `download_path`, which on a paid
    order is a live download URL — see feed_payload for why these two must
    never converge."""
    items = list(order.items.all())
    return {
        "reference": str(order.pk),
        "state": order.state,
        "currency": order.currency,
        "total_cents": order.total_cents,
        "total_amount": order.total_amount,
        "description": order.checkout_description(),
        "paid_at": int(order.paid_at.timestamp()) if order.paid_at else None,
        "items": [
            {
                "sku": item.sku,
                "name": item.name or item.sku,
                "quantity": item.quantity,
                "unit_price_cents": item.unit_price_cents,
                # Present only once the order is paid: the SPA renders a
                # download button from this and nothing else.
                "download_path": download_path(order, item) if order.paid else None,
            }
            for item in items
        ],
    }


def feed_payload(order: ShopOrder) -> dict[str, Any]:
    """A SECOND payload function ON PURPOSE, and an explicit WHITELIST — never
    the private payload minus a key. The order id is excluded because
    `shop_orders.id` IS the OpenReceive reference, protected only by
    `authorize`; it has no business in a public payload."""
    return {
        "buyer": str(order.shop_user.public_ref) if order.shop_user_id else None,
        "total_cents": order.total_cents,
        "total_amount": format_amount(order.total_cents),
        "currency": order.currency,
        "paid_at": int(order.paid_at.timestamp()) if order.paid_at else None,
        "items": [
            {
                "sku": item.sku,
                "name": item.name or item.sku,
                "quantity": item.quantity,
                "image_url": image_url(item.product.image_name) if item.product else None,
            }
            for item in order.items.all()
        ],
    }
