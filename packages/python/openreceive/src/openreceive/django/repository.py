"""The ORM-backed `PaymentRepository`: the same commit locking, write-once
settlement, reconciliation transitions and durable CAS gate as
`openreceive.storage.sql.SqlPaymentRepository`, over the host's Django
connection. The DECISIONS (is a row live, does it conflict or supersede, which
attempt a route acts on) are imported from `openreceive.storage.repository`
and never re-implemented here — this file only knows how to read and write
`OpenReceivePayment` rows.

Per-reference serialization boundary, per backend (the handoff's table):
- PostgreSQL: `pg_advisory_xact_lock(hashtextextended(reference, 8210223))`
  inside `transaction.atomic()` — the same expression and seed as the JS
  repository and the Rails model.
- MySQL/MariaDB: `GET_LOCK('openreceive:'+sha256(reference)[:40], 10)` taken
  BEFORE the transaction on the thread's connection and released AFTER
  commit; releasing inside would leave a window where a second worker could
  commit against state this one already read.
- SQLite: the transaction boundary (`select_for_update()` is a no-op there).
  Give the database `OPTIONS = {"transaction_mode": "IMMEDIATE"}` so two
  concurrent commits queue on the busy timeout instead of failing with
  "database is locked".
The payment_hash UNIQUE constraint is the backstop on every backend.
"""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from django.conf import settings
from django.db import DEFAULT_DB_ALIAS, IntegrityError, connections, transaction

from openreceive.django.models import OpenReceiveMeta, OpenReceivePayment
from openreceive.storage.repository import (
    ADVISORY_LOCK_SEED,
    ATTEMPT_STATUSES,
    PAYMENTS_SCHEMA_VERSION,
    RECONCILE_BATCH_SIZE,
    RECONCILE_GATE_KEY,
    SCHEMA_VERSION_KEY,
    AttemptConflict,
    FulfillHook,
    LockTimeout,
    PaymentInsert,
    PaymentRecord,
    PaymentSettlement,
    ReconcilableAttempt,
    ReconciliationTransition,
    SchemaError,
    SettlementRecord,
    is_fresh_timestamp,
    is_live,
    live_attempt_commit_decision,
    normalize_payment_hash,
)

MYSQL_LOCK_TIMEOUT_SECONDS = 10
RECONCILE_GATE_CAS_RETRIES = 6
STORAGE_GUIDE_URL = "https://openreceive.org/guides/storage.md"


def to_datetime(unix_seconds: int) -> datetime:
    """UTC; timezone-aware when the project runs with USE_TZ (the default),
    naive-UTC otherwise — the Rails `datetime` convention either way."""
    stamp = datetime.fromtimestamp(int(unix_seconds), tz=timezone.utc)
    return stamp if getattr(settings, "USE_TZ", True) else stamp.replace(tzinfo=None)


def to_unix(value: object) -> int:
    if isinstance(value, datetime):
        stamp = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return int(stamp.timestamp())
    if isinstance(value, str):
        return to_unix(datetime.fromisoformat(value))
    if isinstance(value, (int, float)):
        return int(value)
    raise TypeError(f"unsupported timestamp column value: {value!r}")


class DjangoPaymentRepository:
    """`using` names the DATABASES alias the two tables live in (the
    `OPENRECEIVE["DATABASE"]` setting, default "default")."""

    def __init__(
        self, *, using: str = DEFAULT_DB_ALIAS, clock: Callable[[], int] | None = None
    ) -> None:
        self.using = using
        self._clock: Callable[[], int] = clock or (lambda: int(time.time()))
        self._schema_checked = False

    @property
    def vendor(self) -> str:
        vendor: str = connections[self.using].vendor
        return vendor

    def _payments(self) -> Any:
        return OpenReceivePayment.objects.using(self.using)

    def _meta(self) -> Any:
        return OpenReceiveMeta.objects.using(self.using)

    # ------------------------------------------------------------- reads

    def list_for_reference(self, reference: str) -> list[PaymentRecord]:
        self.assert_supported_schema()
        return self._rows_for_reference(reference)

    def list_reconcilable_attempts(self) -> list[ReconcilableAttempt]:
        self.assert_supported_schema()
        rows = (
            self._payments()
            .filter(status="pending")
            .order_by("created_at", "payment_hash")
            .values_list("payment_hash", "created_at", "expires_at")[:RECONCILE_BATCH_SIZE]
        )
        return [self._reconcilable(row) for row in rows]

    def find_pending_attempt(self, payment_hash: str) -> ReconcilableAttempt | None:
        self.assert_supported_schema()
        row = (
            self._payments()
            .filter(payment_hash=payment_hash.lower(), status="pending")
            .values_list("payment_hash", "created_at", "expires_at")
            .first()
        )
        return None if row is None else self._reconcilable(row)

    def find_by_payment_hash(self, payment_hash: str) -> PaymentRecord | None:
        self.assert_supported_schema()
        model = self._payments().filter(payment_hash=payment_hash.lower()).first()
        return None if model is None else self._record(model)

    def count_attempts_from_ip(self, client_ip: str, since_unix_seconds: int) -> int:
        count: int = (
            self._payments()
            .filter(client_ip=client_ip, inserted_at__gte=to_datetime(since_unix_seconds))
            .count()
        )
        return count

    # ------------------------------------------------------------ writes

    def commit_attempt(self, insert: PaymentInsert) -> PaymentRecord:
        self.assert_supported_schema()
        payment_hash = normalize_payment_hash(insert.payment_hash)
        reference = str(insert.reference or "")
        if not reference:
            raise ValueError("reference is required")
        now = self._clock()
        with self._reference_transaction(reference):
            same = self._payments().filter(payment_hash=payment_hash).first()
            if same is not None:
                if same.reference != reference:
                    raise AttemptConflict("payment hash belongs to another reference")
                return self._record(same)
            existing = self._rows_for_reference(reference)
            if any(row.status == "settled" for row in existing):
                raise AttemptConflict("This reference is already paid.")
            for live in (row for row in existing if is_live(row, now)):
                decision = live_attempt_commit_decision(live, insert.swap_data, now)
                if decision == "conflict":
                    raise AttemptConflict(
                        "An unpaid checkout for this payment method is already in progress for this reference."
                    )
                if decision == "supersede":
                    # Marked, not closed: the invoice stays payable until it
                    # expires wallet-side; closing it here on the local clock
                    # would drop it out of the scan set.
                    self._payments().filter(
                        payment_hash=live.payment_hash, status="pending"
                    ).update(status_reason="superseded", updated_at=to_datetime(now))
            stamp = to_datetime(now)
            created = self._payments().create(
                reference=reference,
                payment_hash=payment_hash,
                status="pending",
                status_reason=None,
                paid_at=None,
                expires_at=to_datetime(insert.expires_at),
                checkout_data=dict(insert.checkout),
                swap_data=None if insert.swap_data is None else dict(insert.swap_data),
                client_ip=insert.client_ip or None,
                inserted_at=stamp,
                created_at=to_datetime(insert.created_at),
                updated_at=stamp,
            )
            return self._record(created)

    def record_reconciliation(self, transition: ReconciliationTransition) -> None:
        self.assert_supported_schema()
        if transition.status not in ("expired", "failed", "attention"):
            raise ValueError(f"invalid reconciliation status: {transition.status}")
        # Guarding on status = 'pending' makes the transition idempotent and
        # guarantees a settled attempt is never overwritten.
        self._payments().filter(
            payment_hash=transition.payment_hash.lower(), status="pending"
        ).update(
            status=transition.status,
            status_reason=transition.reason,
            updated_at=to_datetime(transition.observed_at),
        )

    def record_settlement(
        self, settlement: SettlementRecord, fulfill: FulfillHook | None = None
    ) -> bool:
        self.assert_supported_schema()
        payment_hash = settlement.payment_hash.lower()
        preliminary = self._payments().filter(payment_hash=payment_hash).first()
        if preliminary is None:
            return False
        with self._reference_transaction(preliminary.reference):
            rows = self._rows_for_reference(preliminary.reference)
            row = next(
                (candidate for candidate in rows if candidate.payment_hash == payment_hash), None
            )
            if row is None or row.status == "settled":
                return False
            first_for_reference = not any(candidate.status == "settled" for candidate in rows)
            self._payments().filter(payment_hash=payment_hash).update(
                status="settled",
                status_reason=None if first_for_reference else "duplicate_settlement",
                paid_at=to_datetime(settlement.paid_at),
                updated_at=to_datetime(self._clock()),
            )
            if first_for_reference and fulfill is not None:
                # The ORM transaction is ambient (`transaction.atomic()` wraps
                # this block), so the host's on_paid uses plain ORM calls;
                # there is no connection handle to pass.
                fulfill(
                    PaymentSettlement(
                        reference=row.reference,
                        payment_hash=payment_hash,
                        paid_at=int(settlement.paid_at),
                        details=settlement.details,
                        connection=None,
                    )
                )
            return first_for_reference

    def claim_reconcile_gate(self, *, now: int, interval_seconds: int) -> bool:
        """Optimistic CAS over the shared meta row: INSERT-if-absent at rev 0 or
        UPDATE … WHERE rev = expected. The winner is identified by reading back
        its own token — the portable equivalent of an affected-row count. A
        failed scan leaves claimed_at in place so a broken wallet cannot stampede."""
        self.assert_supported_schema()
        claim = json.dumps({"claimed_at": int(now), "token": str(uuid.uuid4())})
        for _ in range(RECONCILE_GATE_CAS_RETRIES):
            with transaction.atomic(using=self.using):
                current = self._meta().filter(key=RECONCILE_GATE_KEY).first()
                if current is None:
                    try:
                        with transaction.atomic(using=self.using):
                            self._meta().create(key=RECONCILE_GATE_KEY, value=claim, rev=0)
                    except IntegrityError:
                        pass
                else:
                    claimed_at = _parse_claimed_at(current.value)
                    if claimed_at is not None and is_fresh_timestamp(
                        int(now), claimed_at, int(interval_seconds)
                    ):
                        return False
                    self._meta().filter(key=RECONCILE_GATE_KEY, rev=current.rev).update(
                        value=claim, rev=int(current.rev) + 1
                    )
                readback = (
                    self._meta()
                    .filter(key=RECONCILE_GATE_KEY)
                    .values_list("value", flat=True)
                    .first()
                )
            if readback == claim:
                return True
        return False

    # ------------------------------------------------------------ schema

    def assert_supported_schema(self) -> None:
        """One probe per repository, on first use (never at import or boot, so
        `migrate` and shells run against an unmigrated database): a missing
        meta table is diagnosed as "the migration never ran here"; a database
        written by a NEWER library is refused."""
        if self._schema_checked:
            return
        connection = connections[self.using]
        meta_table = OpenReceiveMeta._meta.db_table
        if meta_table not in connection.introspection.table_names():
            raise SchemaError(
                f"The {meta_table} table does not exist — the OpenReceive tables have not been migrated "
                "in this database. Run `manage.py migrate openreceive` through your normal workflow. "
                + STORAGE_GUIDE_URL
            )
        stored = self._meta().filter(key=SCHEMA_VERSION_KEY).values_list("value", flat=True).first()
        if stored is not None:
            try:
                version: int | None = int(str(stored).strip())
            except ValueError:
                version = None
            if version is not None and version > PAYMENTS_SCHEMA_VERSION:
                raise SchemaError(
                    f"{meta_table} reports openreceive schema version {version}, newer than this library's "
                    f"{PAYMENTS_SCHEMA_VERSION}. Upgrade openreceive before serving this database."
                )
        self._schema_checked = True

    # --------------------------------------------------------- internals

    @contextmanager
    def _reference_transaction(self, reference: str) -> Iterator[None]:
        connection = connections[self.using]
        if connection.vendor == "mysql":
            name = "openreceive:" + hashlib.sha256(reference.encode("utf-8")).hexdigest()[:40]
            with connection.cursor() as cursor:
                cursor.execute("SELECT GET_LOCK(%s, %s)", [name, MYSQL_LOCK_TIMEOUT_SECONDS])
                acquired = cursor.fetchone()
            if acquired is None or int(acquired[0] or 0) != 1:
                raise LockTimeout("Timed out taking the OpenReceive lock for this reference.")
            try:
                with transaction.atomic(using=self.using):
                    yield
            finally:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT RELEASE_LOCK(%s)", [name])
                    cursor.fetchone()
            return
        with transaction.atomic(using=self.using):
            if connection.vendor == "postgresql":
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT pg_advisory_xact_lock(hashtextextended(%s, %s))",
                        [reference, ADVISORY_LOCK_SEED],
                    )
                    cursor.fetchone()
            yield

    def _rows_for_reference(self, reference: str) -> list[PaymentRecord]:
        return [
            self._record(model)
            for model in self._payments()
            .filter(reference=reference)
            .order_by("-created_at", "-payment_hash")
        ]

    @staticmethod
    def _record(model: OpenReceivePayment) -> PaymentRecord:
        status = str(model.status)
        if status not in ATTEMPT_STATUSES:
            raise ValueError(f"Unexpected openreceive_payments status: {status}")
        return PaymentRecord(
            reference=str(model.reference),
            payment_hash=str(model.payment_hash),
            status=status,
            status_reason=model.status_reason,
            paid_at=None if model.paid_at is None else to_unix(model.paid_at),
            expires_at=to_unix(model.expires_at),
            created_at=to_unix(model.created_at),
            checkout=_json_column(model.checkout_data, "checkout_data", str(model.payment_hash)),
            swap_data=None
            if model.swap_data is None
            else _json_column(model.swap_data, "swap_data", str(model.payment_hash)),
        )

    @staticmethod
    def _reconcilable(row: tuple[Any, Any, Any]) -> ReconcilableAttempt:
        payment_hash, created_at, expires_at = row
        return ReconcilableAttempt(
            payment_hash=str(payment_hash),
            created_at=to_unix(created_at),
            expires_at=to_unix(expires_at),
        )


def _json_column(value: object, column: str, payment_hash: str) -> dict[str, Any]:
    """The message names the column and row only — never the value, which may
    hold server-only swap credentials."""
    if isinstance(value, dict):
        return dict(value)
    if isinstance(value, (str, bytes)):
        try:
            parsed = json.loads(value)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            return parsed
    raise ValueError(
        f"Corrupt {column} JSON on openreceive payment attempt {payment_hash}; the row cannot be read."
    )


def _parse_claimed_at(value: object) -> int | None:
    try:
        parsed = json.loads(str(value))
    except ValueError:
        return None
    claimed_at = parsed.get("claimed_at") if isinstance(parsed, dict) else None
    return (
        int(claimed_at)
        if isinstance(claimed_at, (int, float)) and not isinstance(claimed_at, bool)
        else None
    )
