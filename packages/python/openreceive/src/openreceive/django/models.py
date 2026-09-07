"""The two engine-owned tables as Django models — the same shape as
`openreceive.storage.sql.tables` (datetime columns, JSON, snake_case) and the
Rails migration, so the storage guide's "one engine per table" rule reads the
same everywhere. The host runs the shipped migration through `manage.py
migrate`; `openreceive.django.repository.DjangoPaymentRepository` owns every
write. `swap_data` holds server-only provider credentials: it is excluded from
`__str__`, from the admin below, and must never be serialized by host code."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from django.db import models

from openreceive.storage.repository import ATTEMPT_STATUSES

PAYMENTS_TABLE = "openreceive_payments"
META_TABLE = "openreceive_meta"
# The library's regex for a payment hash, rendered by Django per backend
# (`~` on PostgreSQL, `REGEXP` on MySQL and SQLite).
PAYMENT_HASH_REGEX = r"^[0-9a-f]{64}$"


class OpenReceivePayment(models.Model):
    id: models.BigAutoField[int, int] = models.BigAutoField(primary_key=True)
    # The host's order id, as it passed it. Indexed, never unique: a reference
    # may have many historical attempts.
    reference: models.CharField[str, str] = models.CharField(max_length=255)
    payment_hash: models.CharField[str, str] = models.CharField(max_length=64, unique=True)
    # Attempt lifecycle: pending | settled | expired | failed | attention.
    status: models.CharField[str, str] = models.CharField(max_length=32, default="pending")
    # Operator-facing detail for the current status (e.g. "superseded").
    status_reason: models.CharField[str | None, str | None] = models.CharField(
        max_length=255, null=True, blank=True
    )
    paid_at: models.DateTimeField[datetime | None, datetime | None] = models.DateTimeField(
        null=True, blank=True
    )
    expires_at: models.DateTimeField[datetime, datetime] = models.DateTimeField()
    # Safe checkout response used for retry without another wallet call.
    checkout_data: models.JSONField[Any, Any] = models.JSONField()
    # Server-only provider recovery data. Never return or log this column.
    swap_data: models.JSONField[Any, Any] = models.JSONField(null=True, blank=True)
    # Client IP captured at invoice creation; backs optional rate limiting.
    client_ip: models.CharField[str | None, str | None] = models.CharField(
        max_length=255, null=True, blank=True
    )
    # Immutable local-clock stamp the rate limiter windows on: created_at is
    # the wallet-reported invoice time and updated_at moves on transitions.
    inserted_at: models.DateTimeField[datetime, datetime] = models.DateTimeField()
    created_at: models.DateTimeField[datetime, datetime] = models.DateTimeField()
    updated_at: models.DateTimeField[datetime, datetime] = models.DateTimeField()

    class Meta:
        db_table = PAYMENTS_TABLE
        # Django caps index names at 30 characters; the constraint names match
        # the SQLAlchemy rendering exactly.
        indexes = [
            models.Index(fields=["reference", "created_at"], name="or_payments_ref_created_idx"),
            models.Index(fields=["status", "created_at"], name="or_payments_status_created_idx"),
            models.Index(fields=["client_ip", "inserted_at"], name="or_payments_ip_inserted_idx"),
        ]
        # Database-level backstops for the two invariants the code enforces.
        # Deliberately NO uniqueness over live attempts: liveness is
        # time-dependent, so any such index would reject legitimate reminting.
        constraints = [
            models.CheckConstraint(
                condition=models.Q(status__in=list(ATTEMPT_STATUSES)),
                name=f"{PAYMENTS_TABLE}_status_check",
            ),
            models.CheckConstraint(
                condition=models.Q(payment_hash__regex=PAYMENT_HASH_REGEX),
                name=f"{PAYMENTS_TABLE}_payment_hash_check",
            ),
        ]

    def __str__(self) -> str:
        return f"{self.reference} {self.payment_hash} ({self.status})"

    def __repr__(self) -> str:
        # Never the JSON columns: swap_data may hold a provider credential.
        return f"<OpenReceivePayment {self.reference} {self.payment_hash} {self.status}>"

    def public_dict(self) -> dict[str, Any]:
        """The payer-safe columns only (the PaymentRecord.public_dict twin)."""
        return {
            "reference": self.reference,
            "payment_hash": self.payment_hash,
            "status": self.status,
            "status_reason": self.status_reason,
            "paid_at": self.paid_at,
            "expires_at": self.expires_at,
            "created_at": self.created_at,
            "checkout": dict(self.checkout_data),
        }


class OpenReceiveMeta(models.Model):
    """Key/value/rev rows behind the durable reconcile gate
    (`transaction_scan_gate`) and the `schema_version` marker."""

    key: models.CharField[str, str] = models.CharField(max_length=255, primary_key=True)
    value: models.TextField[str, str] = models.TextField()
    rev: models.BigIntegerField[int, int] = models.BigIntegerField(default=0)

    class Meta:
        db_table = META_TABLE

    def __str__(self) -> str:
        return f"{self.key} (rev {self.rev})"
