"""The two engine-owned tables as SQLAlchemy Core `Table`s, in the Rails shape
(datetime columns, JSON, snake_case): `openreceive_payments` and the
`openreceive_meta` key/value/rev rows behind the durable reconcile gate and
the schema-version marker. One engine per table (docs/guides/storage.md): the
JS DDL stores unix-seconds BIGINTs and TEXT JSON, so it cannot share a table
with this schema; the Django ORM models render the same shape."""

from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    Column,
    DateTime,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    Text,
)

from openreceive.storage.repository import ATTEMPT_STATUSES

DEFAULT_TABLE_NAME = "openreceive_payments"
DEFAULT_META_TABLE_NAME = "openreceive_meta"
IDENTIFIER_PATTERN = re.compile(r"\A[A-Za-z_][A-Za-z0-9_]*\Z")

DIALECT_ALIASES = {
    "postgres": "postgresql",
    "postgresql": "postgresql",
    "psycopg": "postgresql",
    "sqlite": "sqlite",
    "mysql": "mysql",
    "mariadb": "mysql",
}


def normalize_dialect(name: str) -> str:
    try:
        return DIALECT_ALIASES[name.lower()]
    except KeyError:
        raise ValueError(
            f"Unsupported OpenReceive storage dialect: {name} (postgres, sqlite, mysql)"
        )


def assert_identifier(name: str) -> str:
    if IDENTIFIER_PATTERN.match(name) is None:
        raise ValueError(f"Unsafe SQL identifier: {name}")
    return name


def status_check_sql() -> str:
    return "status IN (" + ", ".join(f"'{status}'" for status in ATTEMPT_STATUSES) + ")"


def hash_check_sql(dialect: str) -> str:
    """Dialect predicate for "64 lowercase hexadecimal characters"."""
    normalized = normalize_dialect(dialect)
    if normalized == "postgresql":
        return "payment_hash ~ '^[0-9a-f]{64}$'"
    if normalized == "mysql":
        return "payment_hash REGEXP '^[0-9a-f]{64}$'"
    return "length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*'"


@dataclass(frozen=True)
class PaymentsTables:
    metadata: MetaData
    payments: Table
    meta: Table
    dialect: str


def payments_tables(
    dialect: str,
    table_name: str = DEFAULT_TABLE_NAME,
    meta_table_name: str = DEFAULT_META_TABLE_NAME,
) -> PaymentsTables:
    normalized = normalize_dialect(dialect)
    assert_identifier(table_name)
    assert_identifier(meta_table_name)
    metadata = MetaData()
    payments = Table(
        table_name,
        metadata,
        Column(
            "id",
            BigInteger().with_variant(Integer(), "sqlite"),
            primary_key=True,
            autoincrement=True,
        ),
        # The host's order id, as it passed it.
        Column("reference", String(255), nullable=False),
        Column("payment_hash", String(64), nullable=False, unique=True),
        # Attempt lifecycle: pending | settled | expired | failed | attention.
        Column("status", String(32), nullable=False, server_default="pending"),
        # Operator-facing detail for the current status (e.g. "superseded").
        Column("status_reason", String(255)),
        Column("paid_at", DateTime()),
        Column("expires_at", DateTime(), nullable=False),
        # Safe checkout response used for retry without another wallet call.
        Column("checkout_data", JSON(), nullable=False),
        # Server-only provider recovery data. Never return or log this column.
        Column("swap_data", JSON()),
        # Client IP captured at invoice creation; backs optional rate limiting.
        Column("client_ip", String(255)),
        # Immutable local-clock stamp the rate limiter windows on: created_at is
        # the wallet-reported invoice time and updated_at moves on transitions.
        Column("inserted_at", DateTime(), nullable=False),
        Column("created_at", DateTime(), nullable=False),
        Column("updated_at", DateTime(), nullable=False),
        # Database-level backstops for the two invariants the code enforces.
        # Deliberately NO uniqueness over live attempts: liveness is
        # time-dependent, so any such index would reject legitimate reminting.
        CheckConstraint(status_check_sql(), name=f"{table_name}_status_check"),
        CheckConstraint(hash_check_sql(normalized), name=f"{table_name}_payment_hash_check"),
        Index(f"{table_name}_reference_created_idx", "reference", "created_at"),
        Index(f"{table_name}_status_created_idx", "status", "created_at"),
        Index(f"{table_name}_client_ip_inserted_idx", "client_ip", "inserted_at"),
    )
    meta = Table(
        meta_table_name,
        metadata,
        Column("key", String(255), primary_key=True),
        Column("value", Text(), nullable=False),
        Column("rev", BigInteger(), nullable=False, server_default="0"),
    )
    return PaymentsTables(metadata=metadata, payments=payments, meta=meta, dialect=normalized)
