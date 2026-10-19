"""The payment-attempt repository over Odoo's own PostgreSQL database.

The same commit locking, write-once settlement, reconciliation transitions and
durable CAS gate as the library's `SqlPaymentRepository` on PostgreSQL, in
plain SQL on Odoo cursors, because Odoo ships psycopg2 and not SQLAlchemy. The
decisions (is a row live, does it conflict or supersede) are imported from
`openreceive.storage.repository`, never re-implemented here.

Every operation runs on a cursor of its own and commits before it returns: a
payment attempt must be committed before the payer sees the invoice, and the
per-reference advisory lock must cover the read and the write. Odoo's cursors
run REPEATABLE READ, whose snapshot would be taken before the lock is granted;
each transaction here switches to READ COMMITTED first, so a read after the
lock sees what the previous holder committed. The settlement hook receives the
cursor, so the host marks Odoo's payment transaction done in the same database
transaction that settles the attempt.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

import psycopg2

from openreceive.storage.reconcile_state import checkpoint_state, claim_state, parse_gate
from openreceive.storage.repository import (
    ADVISORY_LOCK_SEED,
    ATTEMPT_STATUSES,
    PAYMENTS_SCHEMA_VERSION,
    RECONCILE_BATCH_SIZE,
    RECONCILE_GATE_KEY,
    SCHEMA_VERSION_KEY,
    AttemptConflict,
    FulfillHook,
    PaymentInsert,
    PaymentRecord,
    PaymentSettlement,
    ReconcilableAttempt,
    ReconciliationTransition,
    SchemaError,
    SettlementRecord,
    is_live,
    live_attempt_commit_decision,
    normalize_payment_hash,
    settlement_expires_at,
)

from .schema import META_TABLE, PAYMENTS_TABLE

RECONCILE_GATE_CAS_RETRIES = 6
PAYMENT_COLUMNS = (
    "reference, payment_hash, status, status_reason, paid_at, expires_at, "
    "created_at, checkout_data, swap_data"
)


def to_datetime(unix_seconds: int) -> datetime:
    """Naive UTC, the convention of the library's other repositories."""
    return datetime.fromtimestamp(int(unix_seconds), tz=timezone.utc).replace(tzinfo=None)


def to_unix(value: object) -> int:
    if isinstance(value, datetime):
        stamp = value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
        return int(stamp.timestamp())
    if isinstance(value, str):
        return to_unix(datetime.fromisoformat(value))
    if isinstance(value, (int, float)):
        return int(value)
    raise TypeError(f"unsupported timestamp column value: {value!r}")


class OdooPaymentRepository:
    supports_after_commit = True

    def __init__(self, database: Any, *, clock: Callable[[], int] | None = None) -> None:
        """`database` is a `runtime.Database`: `transaction()` yields a cursor
        that commits when the block ends."""
        self.database = database
        self._clock: Callable[[], int] = clock or (lambda: int(time.time()))
        self._schema_checked = False

    # ------------------------------------------------------------- reads

    def list_for_reference(self, reference: str) -> list[PaymentRecord]:
        self.assert_supported_schema()
        with self.database.transaction() as cr:
            return self._rows_for_reference(cr, reference)

    def list_reconcilable_attempts(
        self, *, after: dict[str, Any] | None = None, limit: int = RECONCILE_BATCH_SIZE
    ) -> list[ReconcilableAttempt]:
        self.assert_supported_schema()
        query = (
            f"SELECT payment_hash, created_at, checkout_data FROM {PAYMENTS_TABLE} "
            "WHERE status = 'pending'"
        )
        params: list[Any] = []
        if after is not None:
            query += " AND (created_at > %s OR (created_at = %s AND payment_hash > %s))"
            stamp = to_datetime(after["created_at"])
            params += [stamp, stamp, after["payment_hash"]]
        query += " ORDER BY created_at ASC, payment_hash ASC LIMIT %s"
        params.append(min(limit, RECONCILE_BATCH_SIZE))
        with self.database.transaction() as cr:
            cr.execute(query, params)
            return [self._reconcilable(row) for row in cr.fetchall()]

    def find_pending_attempt(self, payment_hash: str) -> ReconcilableAttempt | None:
        self.assert_supported_schema()
        with self.database.transaction() as cr:
            cr.execute(
                f"SELECT payment_hash, created_at, checkout_data FROM {PAYMENTS_TABLE} "
                "WHERE payment_hash = %s AND status = 'pending'",
                [payment_hash.lower()],
            )
            row = cr.fetchone()
        return None if row is None else self._reconcilable(row)

    def find_by_payment_hash(self, payment_hash: str) -> PaymentRecord | None:
        self.assert_supported_schema()
        with self.database.transaction() as cr:
            return self._find_by_hash(cr, payment_hash.lower())

    def count_attempts_from_ip(self, client_ip: str, since_unix_seconds: int) -> int:
        self.assert_supported_schema()
        with self.database.transaction() as cr:
            cr.execute(
                f"SELECT count(*) FROM {PAYMENTS_TABLE} WHERE client_ip = %s AND inserted_at >= %s",
                [client_ip, to_datetime(since_unix_seconds)],
            )
            return int(cr.fetchone()[0])

    def pending_count(self) -> int:
        """How many attempts are still pending: the reconcile cron skips the
        wallet entirely when there are none."""
        with self.database.transaction() as cr:
            cr.execute(f"SELECT count(*) FROM {PAYMENTS_TABLE} WHERE status = 'pending'")
            return int(cr.fetchone()[0])

    # ------------------------------------------------------------ writes

    def commit_attempt(self, insert: PaymentInsert) -> PaymentRecord:
        self.assert_supported_schema()
        payment_hash = normalize_payment_hash(insert.payment_hash)
        reference = str(insert.reference or "")
        if not reference:
            raise ValueError("reference is required")
        now = self._clock()
        with self._reference_transaction(reference) as cr:
            same = self._find_by_hash(cr, payment_hash)
            if same is not None:
                if same.reference != reference:
                    raise AttemptConflict("payment hash belongs to another reference")
                return same
            existing = self._rows_for_reference(cr, reference)
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
                    # expires wallet-side, so the scan must keep covering it.
                    cr.execute(
                        f"UPDATE {PAYMENTS_TABLE} SET status_reason = 'superseded', updated_at = %s "
                        "WHERE payment_hash = %s AND status = 'pending'",
                        [to_datetime(now), live.payment_hash],
                    )
            stamp = to_datetime(now)
            cr.execute(
                f"INSERT INTO {PAYMENTS_TABLE} (reference, payment_hash, status, status_reason, "
                "paid_at, expires_at, checkout_data, swap_data, client_ip, inserted_at, "
                "created_at, updated_at) "
                "VALUES (%s, %s, 'pending', NULL, NULL, %s, %s::json, %s::json, %s, %s, %s, %s)",
                [
                    reference,
                    payment_hash,
                    to_datetime(insert.expires_at),
                    json.dumps(dict(insert.checkout)),
                    None if insert.swap_data is None else json.dumps(dict(insert.swap_data)),
                    insert.client_ip or None,
                    stamp,
                    to_datetime(insert.created_at),
                    stamp,
                ],
            )
            created = self._find_by_hash(cr, payment_hash)
            assert created is not None
            return created

    def record_reconciliation(self, transition: ReconciliationTransition) -> None:
        self.assert_supported_schema()
        if transition.status not in ("expired", "failed", "attention"):
            raise ValueError(f"invalid reconciliation status: {transition.status}")
        record = self.find_by_payment_hash(transition.payment_hash.lower())
        if record is None:
            return
        with self._reference_transaction(record.reference) as cr:
            # Guarding on status = 'pending' makes the transition idempotent and
            # guarantees a settled attempt is never overwritten.
            cr.execute(
                f"UPDATE {PAYMENTS_TABLE} SET status = %s, status_reason = %s, updated_at = %s "
                "WHERE payment_hash = %s AND status = 'pending'",
                [
                    transition.status,
                    transition.reason,
                    to_datetime(transition.observed_at),
                    transition.payment_hash.lower(),
                ],
            )

    def record_settlement(
        self,
        settlement: SettlementRecord,
        fulfill: FulfillHook | None = None,
        *,
        after_commit: FulfillHook | None = None,
    ) -> bool:
        self.assert_supported_schema()
        payment_hash = settlement.payment_hash.lower()
        preliminary = self.find_by_payment_hash(payment_hash)
        if preliminary is None:
            return False
        with self._reference_transaction(preliminary.reference) as cr:
            rows = self._rows_for_reference(cr, preliminary.reference)
            row = next(
                (candidate for candidate in rows if candidate.payment_hash == payment_hash), None
            )
            if row is None or row.status != "pending":
                return False
            first_for_reference = not any(candidate.status == "settled" for candidate in rows)
            cr.execute(
                f"UPDATE {PAYMENTS_TABLE} SET status = 'settled', status_reason = %s, paid_at = %s, "
                "updated_at = %s WHERE payment_hash = %s",
                [
                    None if first_for_reference else "duplicate_settlement",
                    to_datetime(settlement.paid_at),
                    to_datetime(self._clock()),
                    payment_hash,
                ],
            )
            if first_for_reference and fulfill is not None:
                fulfill(
                    PaymentSettlement(
                        reference=row.reference,
                        payment_hash=payment_hash,
                        paid_at=int(settlement.paid_at),
                        details=settlement.details,
                        connection=cr,
                    )
                )
        # The transaction block has committed now.
        if first_for_reference and after_commit is not None:
            after_commit(
                PaymentSettlement(
                    row.reference, payment_hash, int(settlement.paid_at), settlement.details
                )
            )
        return first_for_reference

    def claim_reconcile_gate(
        self, *, now: int, interval_seconds: int, lease_seconds: int = 10
    ) -> dict[str, Any] | None:
        self.assert_supported_schema()
        for _ in range(RECONCILE_GATE_CAS_RETRIES):
            with self.database.transaction() as cr:
                cr.execute(
                    f"SELECT value, rev FROM {META_TABLE} WHERE key = %s", [RECONCILE_GATE_KEY]
                )
                row = cr.fetchone()
                gate = claim_state(
                    parse_gate(row[0] if row else None), now, interval_seconds, lease_seconds
                )
                if gate is None:
                    return None
                encoded = json.dumps(gate)
                if row is None:
                    try:
                        with cr.savepoint(flush=False):
                            cr.execute(
                                f"INSERT INTO {META_TABLE} (key, value, rev) VALUES (%s, %s, 0)",
                                [RECONCILE_GATE_KEY, encoded],
                            )
                    except psycopg2.IntegrityError:
                        continue
                else:
                    cr.execute(
                        f"UPDATE {META_TABLE} SET value = %s, rev = %s WHERE key = %s AND rev = %s",
                        [encoded, row[1] + 1, RECONCILE_GATE_KEY, row[1]],
                    )
                cr.execute(f"SELECT value FROM {META_TABLE} WHERE key = %s", [RECONCILE_GATE_KEY])
                readback = cr.fetchone()
            if readback is not None and readback[0] == encoded:
                return {"token": gate["token"], "scheduler": gate["scheduler"]}
        return None

    def checkpoint_reconcile_gate(
        self, claim: dict[str, Any], scheduler: dict[str, Any], *, now: int, release: bool = False
    ) -> bool:
        self.assert_supported_schema()
        with self.database.transaction() as cr:
            cr.execute(f"SELECT value, rev FROM {META_TABLE} WHERE key = %s", [RECONCILE_GATE_KEY])
            row = cr.fetchone()
            if row is None:
                return False
            gate = checkpoint_state(parse_gate(row[0]), claim, scheduler, now, release)
            if gate is None:
                return False
            cr.execute(
                f"UPDATE {META_TABLE} SET value = %s, rev = %s WHERE key = %s AND rev = %s",
                [json.dumps(gate), row[1] + 1, RECONCILE_GATE_KEY, row[1]],
            )
            return cr.rowcount == 1

    # ------------------------------------------------------------ schema

    def assert_supported_schema(self) -> None:
        """One probe per repository, on first use: missing tables mean the
        module was never activated in this database; a newer schema written by
        a newer library is refused."""
        if self._schema_checked:
            return
        with self.database.transaction() as cr:
            cr.execute("SELECT to_regclass(%s)", [META_TABLE])
            if cr.fetchone()[0] is None:
                raise SchemaError(
                    f"The {META_TABLE} table does not exist: the OpenReceive module is not installed in "
                    "this database. Install or upgrade it under Apps."
                )
            cr.execute(f"SELECT value FROM {META_TABLE} WHERE key = %s", [SCHEMA_VERSION_KEY])
            stored = cr.fetchone()
        if stored is not None:
            try:
                version = int(str(stored[0]).strip())
            except ValueError:
                version = None
            if version is not None and version > PAYMENTS_SCHEMA_VERSION:
                raise SchemaError(
                    f"{META_TABLE} reports openreceive schema version {version}, newer than this "
                    f"library's {PAYMENTS_SCHEMA_VERSION}. Upgrade the openreceive Python package."
                )
        self._schema_checked = True

    # --------------------------------------------------------- internals

    @contextmanager
    def _reference_transaction(self, reference: str) -> Iterator[Any]:
        with self.database.transaction() as cr:
            # The same expression and seed as the library's other repositories.
            cr.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, %s))",
                [reference, ADVISORY_LOCK_SEED],
            )
            yield cr

    def _rows_for_reference(self, cr: Any, reference: str) -> list[PaymentRecord]:
        cr.execute(
            f"SELECT {PAYMENT_COLUMNS} FROM {PAYMENTS_TABLE} WHERE reference = %s "
            "ORDER BY created_at DESC, payment_hash DESC",
            [reference],
        )
        return [self._record(row) for row in cr.fetchall()]

    def _find_by_hash(self, cr: Any, payment_hash: str) -> PaymentRecord | None:
        cr.execute(
            f"SELECT {PAYMENT_COLUMNS} FROM {PAYMENTS_TABLE} WHERE payment_hash = %s",
            [payment_hash],
        )
        row = cr.fetchone()
        return None if row is None else self._record(row)

    @staticmethod
    def _record(row: tuple[Any, ...]) -> PaymentRecord:
        (
            reference,
            payment_hash,
            status,
            status_reason,
            paid_at,
            expires_at,
            created_at,
            checkout,
            swap,
        ) = row
        if status not in ATTEMPT_STATUSES:
            raise ValueError(f"Unexpected openreceive_payments status: {status}")
        return PaymentRecord(
            reference=str(reference),
            payment_hash=str(payment_hash),
            status=str(status),
            status_reason=status_reason,
            paid_at=None if paid_at is None else to_unix(paid_at),
            expires_at=to_unix(expires_at),
            created_at=to_unix(created_at),
            checkout=_json_column(checkout, "checkout_data", str(payment_hash)),
            swap_data=None if swap is None else _json_column(swap, "swap_data", str(payment_hash)),
        )

    @staticmethod
    def _reconcilable(row: tuple[Any, ...]) -> ReconcilableAttempt:
        payment_hash, created_at, checkout = row
        data = _json_column(checkout, "checkout_data", str(payment_hash))
        return ReconcilableAttempt(
            payment_hash=str(payment_hash),
            created_at=to_unix(created_at),
            created_at_source=data.get("created_at_source", "host"),
            expires_at=settlement_expires_at(data, str(payment_hash)),
        )


def _json_column(value: object, column: str, payment_hash: str) -> dict[str, Any]:
    """The message names the column and row only, never the value, which may
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
