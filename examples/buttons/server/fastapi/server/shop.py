"""The shop: products, visitors, orders — everything OpenReceive never sees.

A port of `examples/buttons/shared/server-node/{store,shop-routes,cookie}.ts`
onto SQLAlchemy Core, small enough to read in one sitting. The three hooks in
`main.py` are the only bridge to the engine: `authorize` (the signed visitor
cookie owns the order), `amount_for` (the order row is the price authority)
and `on_paid` (the guarded awaiting_payment → paid transition, inside the
settlement transaction).

SQLite by default (`OPENRECEIVE_DEMO_DB` names the directory), Postgres via
`DATABASE_URL`. The engine's own two tables live in this same database,
rendered from `payments_schema_sql` — never hand-written here.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import Connection, Engine, inspect, text

from openreceive.storage.sql import payments_schema_sql

BUTTONS_ROOT = Path(__file__).resolve().parents[3]
ARTWORK_DIR = BUTTONS_ROOT / "images"
CATALOG_PATH = BUTTONS_ROOT / "shared" / "shop-catalog.json"

MAX_PER_SKU = 10
FEED_LIMIT = 25
AWAITING_PAYMENT = "awaiting_payment"
PAID = "paid"
SHOP_COOKIE = "shop_user_id"
COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60
SEEN_THROTTLE_SECONDS = 5 * 60

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS shop_products (
      id TEXT PRIMARY KEY NOT NULL, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      price_cents INTEGER NOT NULL CHECK (price_cents > 0), position INTEGER NOT NULL DEFAULT 0,
      image_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS shop_users (
      id TEXT PRIMARY KEY NOT NULL, public_ref TEXT NOT NULL UNIQUE,
      first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS shop_orders (
      id TEXT PRIMARY KEY NOT NULL, shop_user_id TEXT NOT NULL REFERENCES shop_users (id),
      state TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (state IN ('awaiting_payment', 'paid')),
      total_cents INTEGER NOT NULL CHECK (total_cents > 0), currency TEXT NOT NULL DEFAULT 'USD',
      paid_at INTEGER, payment_hash TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS shop_order_items (
      id TEXT PRIMARY KEY NOT NULL,
      shop_order_id TEXT NOT NULL REFERENCES shop_orders (id) ON DELETE CASCADE,
      product_id TEXT REFERENCES shop_products (id) ON DELETE SET NULL,
      sku TEXT NOT NULL, name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0),
      quantity INTEGER NOT NULL CHECK (quantity > 0), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE (shop_order_id, sku))""",
    "CREATE INDEX IF NOT EXISTS index_shop_orders_on_state_and_paid_at ON shop_orders (state, paid_at)",
]


def unix_now() -> int:
    return int(time.time())


def format_amount(cents: int) -> str:
    """A decimal string, never a float: the division happens once, here."""
    return f"{cents // 100}.{cents % 100:02d}"


def is_reference(value: object) -> bool:
    try:
        return isinstance(value, str) and str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


# ------------------------------------------------------------------- cookies


def sign_cookie(value: str, secret: str) -> str:
    payload = base64.urlsafe_b64encode(value.encode()).rstrip(b"=").decode()
    digest = hmac.new(secret.encode(), value.encode(), hashlib.sha256).digest()
    return f"{payload}.{base64.urlsafe_b64encode(digest).rstrip(b'=').decode()}"


def read_signed_cookie(signed: str | None, secret: str) -> str | None:
    """The value back, or None for anything that does not verify — a hand-typed
    uuid off the public feed lands in the same branch as no cookie at all."""
    if not signed or "." not in signed:
        return None
    payload, _, _presented = signed.rpartition(".")
    try:
        value = base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)).decode()
    except (ValueError, UnicodeDecodeError):
        return None
    return value if hmac.compare_digest(sign_cookie(value, secret), signed) else None


def resolve_cookie_secret(data_dir: Path, env: dict[str, str]) -> str:
    """`SHOP_COOKIE_SECRET`, else one generated on first boot and kept beside
    the database — a per-process secret would log every visitor out on restart
    and turn the persistence demo into a session demo."""
    if env.get("SHOP_COOKIE_SECRET"):
        return env["SHOP_COOKIE_SECRET"]
    path = data_dir / "fastapi.secret"
    if path.exists():
        return path.read_text().strip()
    secret = secrets.token_hex(32)
    path.write_text(secret + "\n")
    path.chmod(0o600)
    return secret


# --------------------------------------------------------------------- store


@dataclass
class Order:
    row: dict[str, Any]
    items: list[dict[str, Any]]

    @property
    def paid(self) -> bool:
        return self.row["state"] == PAID

    def description(self) -> str:
        parts = [
            f"{item['name']} ×{item['quantity']}" if item["quantity"] > 1 else item["name"]
            for item in self.items
        ]
        count = sum(item["quantity"] for item in self.items)
        return f"OpenReceive {'button' if count == 1 else 'buttons'}: {', '.join(parts)}"


class Store:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine

    def migrate(self) -> None:
        """The shop's tables, the engine's two (rendered by the library) and the
        catalog seed — idempotent, so a restart is a no-op."""
        engine_tables_present = inspect(self.engine).has_table("openreceive_payments")
        with self.engine.begin() as connection:
            for statement in SCHEMA:
                connection.execute(text(statement))
            # The engine's DDL has no IF NOT EXISTS (a migration runs once), so
            # the guard is ours: the table's presence is the "applied" marker.
            if not engine_tables_present:
                for statement in payments_schema_sql(self.engine.dialect.name).split(";\n"):
                    if statement.strip():
                        connection.execute(text(statement.rstrip(";")))
            now = unix_now()
            for entry in json.loads(CATALOG_PATH.read_text()):
                connection.execute(
                    text(
                        "INSERT INTO shop_products (id, sku, name, price_cents, position, image_name, active, created_at, updated_at) "
                        "VALUES (:id, :sku, :name, :price, :position, :image, 1, :now, :now) "
                        "ON CONFLICT (sku) DO UPDATE SET name = excluded.name, price_cents = excluded.price_cents, "
                        "position = excluded.position, image_name = excluded.image_name, active = 1, updated_at = excluded.updated_at"
                    ),
                    {
                        "id": str(uuid.uuid4()),
                        "sku": entry["sku"],
                        "name": entry["name"],
                        "price": entry["price_cents"],
                        "position": entry["position"],
                        "image": entry.get("image_name") or f"openreceive-{entry['sku']}-button.webp",
                        "now": now,
                    },
                )

    def catalog(self) -> list[dict[str, Any]]:
        with self.engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT id, sku, name, price_cents, position, image_name FROM shop_products "
                    "WHERE active = 1 ORDER BY position, price_cents"
                )
            )
            return [dict(row._mapping) for row in rows]

    def visitor(self, cookie: str | None, secret: str) -> tuple[dict[str, Any], str]:
        """The visitor, minting a row the first time this browser is seen; a
        cookie that fails the signature or outlives its row is a NEW visitor."""
        user_id = read_signed_cookie(cookie, secret)
        now = unix_now()
        with self.engine.begin() as connection:
            row = None
            if user_id is not None and is_reference(user_id):
                found = connection.execute(
                    text("SELECT id, public_ref, last_seen_at FROM shop_users WHERE id = :id"),
                    {"id": user_id},
                ).first()
                row = dict(found._mapping) if found else None
            if row is None:
                row = {"id": str(uuid.uuid4()), "public_ref": str(uuid.uuid4()), "last_seen_at": now}
                connection.execute(
                    text(
                        "INSERT INTO shop_users (id, public_ref, first_seen_at, last_seen_at, created_at, updated_at) "
                        "VALUES (:id, :ref, :now, :now, :now, :now)"
                    ),
                    {"id": row["id"], "ref": row["public_ref"], "now": now},
                )
            elif now - int(row["last_seen_at"]) >= SEEN_THROTTLE_SECONDS:
                connection.execute(
                    text("UPDATE shop_users SET last_seen_at = :now WHERE id = :id"),
                    {"now": now, "id": row["id"]},
                )
        return row, sign_cookie(str(row["id"]), secret)

    def create_order(self, requested: object, user_id: str) -> Order | None:
        """THE TRUST BOUNDARY: only sku and quantity survive the cart, prices
        come from the live catalog, unknown skus are dropped, quantities are
        clamped, duplicates merged. None means an empty cart."""
        wanted: dict[str, int] = {}
        for line in requested if isinstance(requested, list) else []:
            if not isinstance(line, dict):
                continue
            sku, quantity = line.get("sku"), line.get("quantity")
            try:
                count = int(quantity)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                continue
            if isinstance(sku, str) and count > 0:
                wanted[sku] = min(wanted.get(sku, 0) + count, MAX_PER_SKU)
        lines = [(product, wanted[product["sku"]]) for product in self.catalog() if product["sku"] in wanted]
        if not lines:
            return None
        now = unix_now()
        order_id = str(uuid.uuid4())
        total = sum(product["price_cents"] * quantity for product, quantity in lines)
        with self.engine.begin() as connection:
            connection.execute(
                text(
                    "INSERT INTO shop_orders (id, shop_user_id, state, total_cents, currency, created_at, updated_at) "
                    "VALUES (:id, :user, 'awaiting_payment', :total, 'USD', :now, :now)"
                ),
                {"id": order_id, "user": user_id, "total": total, "now": now},
            )
            for product, quantity in lines:
                connection.execute(
                    text(
                        "INSERT INTO shop_order_items (id, shop_order_id, product_id, sku, name, unit_price_cents, quantity, created_at, updated_at) "
                        "VALUES (:id, :order, :product, :sku, :name, :price, :quantity, :now, :now)"
                    ),
                    {
                        "id": str(uuid.uuid4()),
                        "order": order_id,
                        "product": product["id"],
                        "sku": product["sku"],
                        "name": product["name"],
                        "price": product["price_cents"],
                        "quantity": quantity,
                        "now": now,
                    },
                )
        return self.order(order_id)

    def order(self, reference: object) -> Order | None:
        if not is_reference(reference):
            return None
        with self.engine.connect() as connection:
            row = connection.execute(
                text(
                    "SELECT id, shop_user_id, state, total_cents, currency, paid_at, payment_hash, created_at "
                    "FROM shop_orders WHERE id = :id"
                ),
                {"id": reference},
            ).first()
            if row is None:
                return None
            return Order(dict(row._mapping), self._items(connection, str(row._mapping["id"])))

    def _items(self, connection: Connection, order_id: str) -> list[dict[str, Any]]:
        rows = connection.execute(
            text(
                "SELECT i.sku, i.name, i.unit_price_cents, i.quantity, p.image_name AS image_name "
                "FROM shop_order_items i LEFT JOIN shop_products p ON p.id = i.product_id "
                "WHERE i.shop_order_id = :id ORDER BY i.created_at, i.sku"
            ),
            {"id": order_id},
        )
        return [dict(row._mapping) for row in rows]

    def recent_orders(self) -> tuple[list[tuple[Order, str | None]], dict[str, int]]:
        with self.engine.connect() as connection:
            rows = connection.execute(
                text(
                    "SELECT o.id, o.shop_user_id, o.state, o.total_cents, o.currency, o.paid_at, o.payment_hash, "
                    "o.created_at, u.public_ref AS buyer FROM shop_orders o LEFT JOIN shop_users u ON u.id = o.shop_user_id "
                    "WHERE o.state = 'paid' ORDER BY o.paid_at DESC, o.created_at DESC LIMIT :limit"
                ),
                {"limit": FEED_LIMIT},
            ).all()
            orders = [
                (Order({k: v for k, v in row._mapping.items() if k != "buyer"}, self._items(connection, str(row._mapping["id"]))), row._mapping["buyer"])
                for row in rows
            ]
            paid = connection.execute(text("SELECT COUNT(*) FROM shop_orders WHERE state = 'paid'")).scalar_one()
            sold = connection.execute(
                text(
                    "SELECT COALESCE(SUM(i.quantity), 0) FROM shop_order_items i JOIN shop_orders o ON o.id = i.shop_order_id WHERE o.state = 'paid'"
                )
            ).scalar_one()
        return orders, {"paid_orders": int(paid), "buttons_sold": int(sold)}


def claim_order_paid(connection: Connection, reference: str, paid_at: int, payment_hash: str) -> bool:
    """THE GUARDED TRANSITION: the WHERE clause is the lock. Runs on the
    settlement transaction's own connection, so the order flip and the payment
    record commit together — or not at all."""
    if not is_reference(reference):
        return False
    result = connection.execute(
        text(
            "UPDATE shop_orders SET state = 'paid', paid_at = :paid_at, payment_hash = :hash, updated_at = :now "
            "WHERE id = :id AND state = 'awaiting_payment'"
        ),
        {"paid_at": paid_at, "hash": payment_hash, "now": unix_now(), "id": reference},
    )
    return bool(result.rowcount)


# ------------------------------------------------------------------ payloads


def image_url(image_name: str | None) -> str | None:
    return None if image_name is None else f"/images/{image_name}"


def order_payload(order: Order) -> dict[str, Any]:
    """The PRIVATE payload: `download_path` is a live URL once paid."""
    reference = order.row["id"]
    return {
        "reference": reference,
        "state": order.row["state"],
        "currency": order.row["currency"],
        "total_cents": order.row["total_cents"],
        "total_amount": format_amount(order.row["total_cents"]),
        "description": order.description(),
        "paid_at": order.row["paid_at"],
        "items": [
            {
                "sku": item["sku"],
                "name": item["name"] or item["sku"],
                "quantity": item["quantity"],
                "unit_price_cents": item["unit_price_cents"],
                "download_path": f"/shop/orders/{reference}/downloads/{item['sku']}" if order.paid else None,
            }
            for item in order.items
        ],
    }


def feed_payload(order: Order, buyer: str | None) -> dict[str, Any]:
    """The PUBLIC payload — an explicit whitelist, never the private one minus
    a key: no order id (it IS the OpenReceive reference), no download path."""
    return {
        "buyer": buyer,
        "total_cents": order.row["total_cents"],
        "total_amount": format_amount(order.row["total_cents"]),
        "currency": order.row["currency"],
        "paid_at": order.row["paid_at"],
        "items": [
            {"sku": item["sku"], "name": item["name"] or item["sku"], "quantity": item["quantity"], "image_url": image_url(item["image_name"])}
            for item in order.items
        ],
    }
