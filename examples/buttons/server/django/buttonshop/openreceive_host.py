"""THE THREE HOOKS. The only bridge between the OpenReceive engine and this
application's data: OpenReceive never sees ShopOrder, ShopProduct, ShopUser,
the cart, or the download. If a future change to this demo needs a fourth
hook, that is a signal the boundary moved, and it is worth stopping over.

Written the way `manage.py openreceive_install shop` scaffolds it, then filled
in for the button shop. settings.OPENRECEIVE["HOST"] points here.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from django.http import HttpRequest

from buttonshop.shop.identity import visitor_id_from
from buttonshop.shop.models import ShopOrder
from openreceive.server import HookContext
from openreceive.storage import PaymentSettlement

log = logging.getLogger("buttonshop")


class Host:
    # THE HOST AUTHORIZES EVERY REQUEST; OpenReceive mints no tokens.
    #
    # This shop's policy: an order id is a uuid, so it is not enumerable — but
    # it travels in every request body the payer's browser sends, so possession
    # of one is a claim, not proof. The order has to belong to THIS browser,
    # which is the same check the shop's own views make. The cookie is read
    # straight off the Django request the engine hands us; a tampered value
    # fails the signature and reads as None, the same `False` as a missing one.
    def authorize(self, context: HookContext) -> bool:
        request = context.request
        if not isinstance(request, HttpRequest):
            return False
        order = ShopOrder.find_by_reference(context.resource.get("reference"))
        if order is None:
            return False
        visitor_id = visitor_id_from(request)
        return visitor_id is not None and str(order.shop_user_id) == visitor_id

    # The price for a reference — here the ShopOrder id — read from our own
    # row. Nothing a payer sends can reach this number: the create body cannot
    # carry an amount at all. None means there is nothing to pay for (a 404).
    # `value` is a decimal STRING formatted from integer cents. Never a float.
    # `description` is what the payer is BUYING, in our own words.
    def amount_for(self, reference: str) -> dict[str, Any] | None:
        order = ShopOrder.find_by_reference(reference)
        if order is None:
            return None
        return {
            "currency": order.currency,
            "value": order.total_amount,
            "description": order.checkout_description(),
        }

    # Runs INSIDE the settlement transaction (the engine wraps it in
    # transaction.atomic()), only for the order's first settled attempt.
    # Across every settlement path OpenReceive owns this runs AT MOST ONCE per
    # reference. What OpenReceive cannot see is a second fulfillment path of
    # OUR own, so the transition is still the guarded conditional UPDATE in
    # ShopOrder.claim_paid — the WHERE clause is the lock.
    #
    # Fulfillment for a virtual product: flipping the order to `paid` IS the
    # delivery, because the download view serves the artwork only from a paid
    # row. DATABASE WRITES ONLY in here; anything that must not survive a
    # rollback belongs in after_paid.
    def on_paid(self, settlement: PaymentSettlement) -> None:
        ShopOrder.claim_paid(
            reference=settlement.reference,
            paid_at=datetime.fromtimestamp(settlement.paid_at, tz=timezone.utc),
            payment_hash=settlement.payment_hash,
        )

    # After COMMIT, once. This stack pushes nothing (the checkout and the feed
    # poll), so a log line is the whole of it; a Channels broadcast or an
    # email would go here, never in on_paid.
    def after_paid(self, settlement: PaymentSettlement) -> None:
        log.info("order %s paid (payment_hash %s)", settlement.reference, settlement.payment_hash)
