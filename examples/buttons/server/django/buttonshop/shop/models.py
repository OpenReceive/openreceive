"""The shop's four tables — the Rails demo's data shape, on the Django ORM.

OpenReceive never sees any of this. The three hooks in
buttonshop/openreceive_host.py are the only bridge:
  authorize   -> ShopOrder.shop_user_id vs. the signed visitor cookie
  amount_for  -> ShopOrder.total_amount / checkout_description, below
  on_paid     -> ShopOrder.claim_paid, below
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Any

from django.db import models
from django.db.models import Q, Sum
from django.utils import timezone

# A cart is a few buttons, not a wholesale order.
MAX_PER_SKU = 10
# How many rows the public feed shows, and the only limit it honours.
FEED_LIMIT = 25
CURRENCY = "USD"

AWAITING_PAYMENT = "awaiting_payment"
PAID = "paid"
STATES = (AWAITING_PAYMENT, PAID)

UUID_PATTERN = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z", re.I)
SKU_PATTERN = re.compile(r"\A[a-z]+(?:-[a-z]+)*\Z")


def is_reference(value: object) -> bool:
    """The reference arrives as a string the payer's browser sent. Postgres
    RAISES on a malformed uuid literal, so the format check happens before
    the query — every caller is on a request path an anonymous payer can reach."""
    return isinstance(value, str) and UUID_PATTERN.match(value) is not None


def format_amount(cents: int) -> str:
    """A decimal string, never a float. The division happens once, here."""
    return f"{cents // 100}.{cents % 100:02d}"


def default_image_name(sku: str) -> str:
    return f"openreceive-{sku}-button.webp"


class ShopProduct(models.Model):
    """THE PRICE AUTHORITY. `amount_for` reads it through ShopOrder, and nothing
    a payer sends can reach it: the cart carries a SKU and a quantity, never a
    price. Read fresh on every order creation — never memoized."""

    id: models.UUIDField[uuid.UUID, uuid.UUID] = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False
    )
    sku: models.CharField[str, str] = models.CharField(max_length=64, unique=True)
    name: models.CharField[str, str] = models.CharField(max_length=255)
    price_cents: models.IntegerField[int, int] = models.IntegerField()
    position: models.IntegerField[int, int] = models.IntegerField(default=0)
    # The artwork filename lives on the ROW rather than being derived from the
    # SKU; the convention is only the default (see default_image_name).
    image_name: models.CharField[str, str] = models.CharField(max_length=255)
    active: models.BooleanField[bool, bool] = models.BooleanField(default=True)
    created_at: models.DateTimeField[datetime, datetime] = models.DateTimeField(auto_now_add=True)
    updated_at: models.DateTimeField[datetime, datetime] = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "shop_products"
        ordering = ["position", "price_cents"]
        indexes = [models.Index(fields=["active", "position"], name="shop_products_active_pos_idx")]
        constraints = [
            models.CheckConstraint(
                condition=Q(price_cents__gt=0), name="shop_products_price_cents_check"
            )
        ]

    def __str__(self) -> str:
        return f"{self.sku} ({format_amount(self.price_cents)})"

    @classmethod
    def active_by_sku(cls, sku: object) -> ShopProduct | None:
        """Look a SKU up in the LIVE, active catalog. `active=False` hides a
        product from the catalog and from order creation; it must NOT break an
        existing order's receipt, download or feed row — the snapshots on
        ShopOrderItem are for that."""
        if not isinstance(sku, str) or SKU_PATTERN.match(sku) is None:
            return None
        return cls.objects.filter(active=True, sku=sku).first()

    def save(self, *args: Any, **kwargs: Any) -> None:
        if not self.image_name and self.sku:
            self.image_name = default_image_name(self.sku)
        super().save(*args, **kwargs)


class ShopUser(models.Model):
    """A visitor, remembered by a signed cookie holding `id`. No email, no
    name, no password. TWO UUIDS, ON PURPOSE: `id` is the ownership token that
    travels in the signed cookie and is never rendered anywhere; `public_ref`
    is the handle the public feed shows."""

    id: models.UUIDField[uuid.UUID, uuid.UUID] = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False
    )
    public_ref: models.UUIDField[uuid.UUID, uuid.UUID] = models.UUIDField(
        default=uuid.uuid4, unique=True, editable=False
    )
    first_seen_at: models.DateTimeField[datetime, datetime] = models.DateTimeField()
    last_seen_at: models.DateTimeField[datetime, datetime] = models.DateTimeField()

    # How long a row may go untouched before touch_seen writes again.
    SEEN_THROTTLE_SECONDS = 300

    class Meta:
        db_table = "shop_users"

    def __str__(self) -> str:
        return str(self.public_ref)

    def touch_seen(self) -> None:
        """Throttled: a page load is a dozen requests and remembering "last
        seen" must not be a write storm."""
        now = timezone.now()
        if (now - self.last_seen_at).total_seconds() < self.SEEN_THROTTLE_SECONDS:
            return
        ShopUser.objects.filter(pk=self.pk).update(last_seen_at=now)
        self.last_seen_at = now


class ShopOrder(models.Model):
    """One cart checkout. The id IS the OpenReceive `reference`: created before
    checkout, kept across every retry, never reused, and unguessable because
    it is a uuid rather than a sequential integer."""

    id: models.UUIDField[uuid.UUID, uuid.UUID] = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False
    )
    shop_user: models.ForeignKey[ShopUser, ShopUser] = models.ForeignKey(
        ShopUser, on_delete=models.CASCADE, related_name="orders"
    )
    state: models.CharField[str, str] = models.CharField(max_length=32, default=AWAITING_PAYMENT)
    currency: models.CharField[str, str] = models.CharField(max_length=3, default=CURRENCY)
    total_cents: models.IntegerField[int, int] = models.IntegerField()
    paid_at: models.DateTimeField[datetime | None, datetime | None] = models.DateTimeField(
        null=True, blank=True
    )
    payment_hash: models.CharField[str | None, str | None] = models.CharField(
        max_length=64, null=True, blank=True
    )
    created_at: models.DateTimeField[datetime, datetime] = models.DateTimeField(auto_now_add=True)
    updated_at: models.DateTimeField[datetime, datetime] = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "shop_orders"
        indexes = [
            models.Index(fields=["state", "created_at"], name="shop_orders_state_created_idx"),
            models.Index(fields=["state", "paid_at"], name="shop_orders_state_paid_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=Q(state__in=list(STATES)), name="shop_orders_state_check"
            ),
            models.CheckConstraint(
                condition=Q(total_cents__gt=0), name="shop_orders_total_cents_check"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.id} {self.state} {format_amount(self.total_cents)}"

    @classmethod
    def find_by_reference(cls, reference: object) -> ShopOrder | None:
        if not is_reference(reference):
            return None
        return cls.objects.filter(pk=reference).first()

    @classmethod
    def create_from_lines(
        cls, lines: list[tuple[ShopProduct, int]], *, shop_user: ShopUser
    ) -> ShopOrder:
        """One transaction: the order and every item, with the totals summed
        from the PRODUCT rows the view looked up. Nothing here reads a number
        the browser sent. Name and unit price are copied onto the item so
        history does not move when the catalog does."""
        from django.db import transaction

        with transaction.atomic():
            order = cls.objects.create(
                shop_user=shop_user,
                state=AWAITING_PAYMENT,
                currency=CURRENCY,
                total_cents=sum(product.price_cents * quantity for product, quantity in lines),
            )
            for product, quantity in lines:
                ShopOrderItem.objects.create(
                    shop_order=order,
                    product=product,
                    sku=product.sku,
                    name=product.name,
                    unit_price_cents=product.price_cents,
                    quantity=quantity,
                )
        return order

    @property
    def paid(self) -> bool:
        return self.state == PAID

    @property
    def total_amount(self) -> str:
        """A decimal string for `amount_for`. Integers all the way down."""
        return format_amount(self.total_cents)

    def checkout_description(self) -> str:
        """What the payer is BUYING, in our own words — one display string the
        checkout renders above the amount. Built from the item SNAPSHOTS, so
        it reads the same after a catalog edit."""
        items = list(self.items.all())
        parts = [
            f"{item.name or item.sku} ×{item.quantity}"
            if item.quantity > 1
            else (item.name or item.sku)
            for item in items
        ]
        count = sum(item.quantity for item in items)
        noun = "button" if count == 1 else "buttons"
        return f"OpenReceive {noun}: {', '.join(parts)}"

    @classmethod
    def claim_paid(cls, *, reference: object, paid_at: datetime, payment_hash: str) -> bool:
        """THE GUARDED TRANSITION, idempotent by construction: the WHERE clause
        is the lock. Whoever flips awaiting_payment -> paid first is the only
        one who fulfills; a later attempt updates zero rows and does nothing.
        One conditional UPDATE, no model code and no signals between the check
        and the write — the `update_all` twin. OpenReceive already runs
        on_paid at most once per reference; this is written this way because
        OpenReceive cannot see a second fulfillment path of OURS."""
        if not is_reference(reference):
            return False
        claimed = cls.objects.filter(pk=reference, state=AWAITING_PAYMENT).update(
            state=PAID, paid_at=paid_at, payment_hash=payment_hash, updated_at=timezone.now()
        )
        return claimed > 0

    @classmethod
    def recent_paid(cls) -> Any:
        return (
            cls.objects.filter(state=PAID)
            .select_related("shop_user")
            .prefetch_related("items__product")
            .order_by("-paid_at", "-created_at")[:FEED_LIMIT]
        )

    @classmethod
    def feed_totals(cls) -> dict[str, int]:
        sold = ShopOrderItem.objects.filter(shop_order__state=PAID).aggregate(n=Sum("quantity"))[
            "n"
        ]
        return {
            "paid_orders": cls.objects.filter(state=PAID).count(),
            "buttons_sold": int(sold or 0),
        }


class ShopOrderItem(models.Model):
    """One sku on one order, with name and price SNAPSHOTTED beside a nullable
    product FK: deactivating or deleting a product must not break a receipt,
    a download or a feed row somebody already paid for."""

    id: models.UUIDField[uuid.UUID, uuid.UUID] = models.UUIDField(
        primary_key=True, default=uuid.uuid4, editable=False
    )
    shop_order: models.ForeignKey[ShopOrder, ShopOrder] = models.ForeignKey(
        ShopOrder, on_delete=models.CASCADE, related_name="items"
    )
    product: models.ForeignKey[ShopProduct | None, ShopProduct | None] = models.ForeignKey(
        ShopProduct, null=True, blank=True, on_delete=models.SET_NULL, related_name="order_items"
    )
    sku: models.CharField[str, str] = models.CharField(max_length=64)
    name: models.CharField[str, str] = models.CharField(max_length=255)
    unit_price_cents: models.IntegerField[int, int] = models.IntegerField()
    quantity: models.IntegerField[int, int] = models.IntegerField()
    created_at: models.DateTimeField[datetime, datetime] = models.DateTimeField(auto_now_add=True)

    class Meta:
        db_table = "shop_order_items"
        ordering = ["created_at"]
        constraints = [
            models.UniqueConstraint(
                fields=["shop_order", "sku"], name="shop_order_items_order_sku_uniq"
            ),
            models.CheckConstraint(
                condition=Q(quantity__gt=0), name="shop_order_items_quantity_check"
            ),
            models.CheckConstraint(
                condition=Q(unit_price_cents__gt=0), name="shop_order_items_unit_price_cents_check"
            ),
        ]

    def __str__(self) -> str:
        return f"{self.sku} ×{self.quantity}"

    @property
    def image_name(self) -> str:
        """The product's file when it still exists, the SKU convention when it
        does not — a deleted product must not break a download somebody paid for."""
        product = self.product
        return product.image_name if product is not None else default_image_name(self.sku)
