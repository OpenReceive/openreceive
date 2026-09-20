"""The library-owned payment-attempt repository over the host's SQLAlchemy
`Engine`: commit locking, settlement write-once and reconciliation transitions
so hosts never implement them. Twin of the Rails `OpenReceivePayment` /
`OpenReceiveMeta` models and the JS `createSqlPayments`.

Per-reference serialization boundary, per dialect:
- PostgreSQL: a transaction-scoped advisory lock with the same expression and
  seed as the JS repository and the Rails model —
  `pg_advisory_xact_lock(hashtextextended(reference, 8210223))`.
- MySQL/MariaDB: `GET_LOCK` (session-scoped) taken BEFORE the transaction and
  released AFTER commit; releasing inside would leave a window where a second
  worker could commit against state this one already read.
- SQLite: writers serialize themselves; the repository configures the engine
  for `BEGIN IMMEDIATE` plus a busy timeout so two concurrent commits queue
  instead of failing with "database is locked". Give OpenReceive its own
  `Engine` for its two tables (same database file) — the plan's FastAPI shape.
The payment_hash UNIQUE constraint is the backstop on every dialect.
"""

from __future__ import annotations

import hashlib
import json
import time
import weakref
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import Connection, Engine, and_, event, func, inspect, or_, select, text
from sqlalchemy.exc import IntegrityError

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
    LockTimeout,
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
from openreceive.storage.sql.tables import (
    DEFAULT_META_TABLE_NAME,
    DEFAULT_TABLE_NAME,
    PaymentsTables,
    payments_tables,
)

MYSQL_LOCK_TIMEOUT_SECONDS = 10
SQLITE_BUSY_TIMEOUT_MS = 10_000
RECONCILE_GATE_CAS_RETRIES = 6

STORAGE_GUIDE_URL = "https://openreceive.org/guides/storage.md"

_configured_sqlite_engines: weakref.WeakSet[Engine] = weakref.WeakSet()


def to_datetime(unix_seconds: int) -> datetime:
    """Naive UTC, the Rails `datetime` convention on every dialect."""
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


def configure_sqlite_engine(engine: Engine) -> None:
    """Serializable SQLite writers: pysqlite's deferred BEGIN is disabled and
    every SQLAlchemy transaction opens with BEGIN IMMEDIATE, so two commits for
    one reference queue on the busy timeout instead of racing. Idempotent."""
    if engine.dialect.name != "sqlite" or engine in _configured_sqlite_engines:
        return
    _configured_sqlite_engines.add(engine)

    @event.listens_for(engine, "connect")
    def _connect(dbapi_connection: Any, _record: Any) -> None:
        dbapi_connection.isolation_level = None
        dbapi_connection.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")

    @event.listens_for(engine, "begin")
    def _begin(connection: Connection) -> None:
        connection.exec_driver_sql("BEGIN IMMEDIATE")

    # Connections already in the pool predate the listeners.
    engine.dispose()


class SqlPaymentRepository:
    supports_after_commit = True

    def __init__(
        self,
        engine: Engine,
        *,
        table_name: str = DEFAULT_TABLE_NAME,
        meta_table_name: str = DEFAULT_META_TABLE_NAME,
        clock: Callable[[], int] | None = None,
    ) -> None:
        self.engine = engine
        self.dialect = engine.dialect.name
        self.tables: PaymentsTables = payments_tables(self.dialect, table_name, meta_table_name)
        self._clock: Callable[[], int] = clock or (lambda: int(time.time()))
        self._schema_checked = False
        configure_sqlite_engine(engine)

    # ------------------------------------------------------------- reads

    def list_for_reference(self, reference: str) -> list[PaymentRecord]:
        self.assert_supported_schema()
        with self.engine.connect() as connection:
            return self._rows_for_reference(connection, reference)

    def list_reconcilable_attempts(
        self, *, after: dict[str, Any] | None = None, limit: int = RECONCILE_BATCH_SIZE
    ) -> list[ReconcilableAttempt]:
        self.assert_supported_schema()
        payments = self.tables.payments
        query = (
            select(payments.c.payment_hash, payments.c.created_at, payments.c.checkout_data)
            .where(payments.c.status == "pending")
            .order_by(payments.c.created_at.asc(), payments.c.payment_hash.asc())
            .limit(min(limit, RECONCILE_BATCH_SIZE))
        )
        if after is not None:
            query = query.where(
                or_(
                    payments.c.created_at > to_datetime(after["created_at"]),
                    and_(
                        payments.c.created_at == to_datetime(after["created_at"]),
                        payments.c.payment_hash > after["payment_hash"],
                    ),
                )
            )
        with self.engine.connect() as connection:
            return [self._reconcilable(row) for row in connection.execute(query)]

    def find_pending_attempt(self, payment_hash: str) -> ReconcilableAttempt | None:
        self.assert_supported_schema()
        payments = self.tables.payments
        query = select(
            payments.c.payment_hash, payments.c.created_at, payments.c.checkout_data
        ).where(payments.c.payment_hash == payment_hash.lower(), payments.c.status == "pending")
        with self.engine.connect() as connection:
            row = connection.execute(query).first()
        return None if row is None else self._reconcilable(row)

    def find_by_payment_hash(self, payment_hash: str) -> PaymentRecord | None:
        self.assert_supported_schema()
        with self.engine.connect() as connection:
            return self._find_by_hash(connection, payment_hash.lower())

    def count_attempts_from_ip(self, client_ip: str, since_unix_seconds: int) -> int:
        self.assert_supported_schema()
        payments = self.tables.payments
        query = (
            select(func.count())
            .select_from(payments)
            .where(
                payments.c.client_ip == client_ip,
                payments.c.inserted_at >= to_datetime(since_unix_seconds),
            )
        )
        with self.engine.connect() as connection:
            return int(connection.execute(query).scalar_one())

    # ------------------------------------------------------------ writes

    def commit_attempt(self, insert: PaymentInsert) -> PaymentRecord:
        self.assert_supported_schema()
        payment_hash = normalize_payment_hash(insert.payment_hash)
        reference = str(insert.reference or "")
        if not reference:
            raise ValueError("reference is required")
        now = self._clock()
        with self._reference_transaction(reference) as connection:
            same = self._find_by_hash(connection, payment_hash)
            if same is not None:
                if same.reference != reference:
                    raise AttemptConflict("payment hash belongs to another reference")
                return same
            existing = self._rows_for_reference(connection, reference)
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
                    payments = self.tables.payments
                    connection.execute(
                        payments.update()
                        .where(
                            payments.c.payment_hash == live.payment_hash,
                            payments.c.status == "pending",
                        )
                        .values(status_reason="superseded", updated_at=to_datetime(now))
                    )
            stamp = to_datetime(now)
            connection.execute(
                self.tables.payments.insert().values(
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
            )
            created = self._find_by_hash(connection, payment_hash)
            assert created is not None
            return created

    def record_reconciliation(self, transition: ReconciliationTransition) -> None:
        self.assert_supported_schema()
        if transition.status not in ("expired", "failed", "attention"):
            raise ValueError(f"invalid reconciliation status: {transition.status}")
        payments = self.tables.payments
        record = self.find_by_payment_hash(transition.payment_hash.lower())
        if record is None:
            return
        with self._reference_transaction(record.reference) as connection:
            # Guarding on status = 'pending' makes the transition idempotent and
            # guarantees a settled attempt is never overwritten.
            connection.execute(
                payments.update()
                .where(
                    payments.c.payment_hash == transition.payment_hash.lower(),
                    payments.c.status == "pending",
                )
                .values(
                    status=transition.status,
                    status_reason=transition.reason,
                    updated_at=to_datetime(transition.observed_at),
                )
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
        with self.engine.connect() as connection:
            preliminary = self._find_by_hash(connection, payment_hash)
        if preliminary is None:
            return False
        with self._reference_transaction(preliminary.reference) as connection:
            rows = self._rows_for_reference(connection, preliminary.reference)
            row = next(
                (candidate for candidate in rows if candidate.payment_hash == payment_hash), None
            )
            if row is None or row.status != "pending":
                return False
            first_for_reference = not any(candidate.status == "settled" for candidate in rows)
            payments = self.tables.payments
            connection.execute(
                payments.update()
                .where(payments.c.payment_hash == payment_hash)
                .values(
                    status="settled",
                    status_reason=None if first_for_reference else "duplicate_settlement",
                    paid_at=to_datetime(settlement.paid_at),
                    updated_at=to_datetime(self._clock()),
                )
            )
            if first_for_reference and fulfill is not None:
                fulfill(
                    PaymentSettlement(
                        reference=row.reference,
                        payment_hash=payment_hash,
                        paid_at=int(settlement.paid_at),
                        details=settlement.details,
                        connection=connection,
                    )
                )
        # _reference_transaction owns this connection and has committed now.
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
        meta = self.tables.meta
        for _ in range(RECONCILE_GATE_CAS_RETRIES):
            with self.engine.begin() as connection:
                row = connection.execute(
                    select(meta.c.value, meta.c.rev).where(meta.c.key == RECONCILE_GATE_KEY)
                ).first()
                gate = claim_state(
                    parse_gate(row.value if row else None), now, interval_seconds, lease_seconds
                )
                if gate is None:
                    return None
                encoded = json.dumps(gate)
                if row is None:
                    try:
                        with connection.begin_nested():
                            connection.execute(
                                meta.insert().values(key=RECONCILE_GATE_KEY, value=encoded, rev=0)
                            )
                    except IntegrityError:
                        continue
                else:
                    connection.execute(
                        meta.update()
                        .where(meta.c.key == RECONCILE_GATE_KEY, meta.c.rev == row.rev)
                        .values(value=encoded, rev=row.rev + 1)
                    )
                readback = connection.execute(
                    select(meta.c.value).where(meta.c.key == RECONCILE_GATE_KEY)
                ).scalar()
            if readback == encoded:
                return {"token": gate["token"], "scheduler": gate["scheduler"]}
        return None

    def checkpoint_reconcile_gate(
        self, claim: dict[str, Any], scheduler: dict[str, Any], *, now: int, release: bool = False
    ) -> bool:
        self.assert_supported_schema()
        meta = self.tables.meta
        with self.engine.begin() as connection:
            row = connection.execute(
                select(meta.c.value, meta.c.rev).where(meta.c.key == RECONCILE_GATE_KEY)
            ).first()
            if row is None:
                return False
            gate = checkpoint_state(parse_gate(row.value), claim, scheduler, now, release)
            if gate is None:
                return False
            result = connection.execute(
                meta.update()
                .where(meta.c.key == RECONCILE_GATE_KEY, meta.c.rev == row.rev)
                .values(value=json.dumps(gate), rev=row.rev + 1)
            )
            return result.rowcount == 1

    def maintenance_candidates(
        self, *, after: dict[str, Any] | None = None, limit: int = 100
    ) -> dict[str, Any]:
        """Bounded dry-run report; paginate with next_cursor until it is None."""
        from openreceive.storage.maintenance import repair_candidate

        self.assert_supported_schema()
        payments = self.tables.payments
        limit = min(max(limit, 1), 1000)
        query = select(payments).where(payments.c.status.in_(["attention", "expired"]))
        if after is not None:
            query = query.where(
                or_(
                    payments.c.updated_at > to_datetime(after["updated_at"]),
                    and_(
                        payments.c.updated_at == to_datetime(after["updated_at"]),
                        payments.c.payment_hash > after["payment_hash"],
                    ),
                )
            )
        with self.engine.connect() as connection:
            rows = list(
                connection.execute(
                    query.order_by(payments.c.updated_at, payments.c.payment_hash).limit(limit)
                )
            )
            candidates = [
                repair_candidate(self._record(row._mapping), to_unix(row.updated_at))
                for row in rows
            ]
        cursor = (
            {"updated_at": to_unix(rows[-1].updated_at), "payment_hash": str(rows[-1].payment_hash)}
            if len(rows) == limit
            else None
        )
        return {
            "candidates": [candidate for candidate in candidates if candidate is not None],
            "next_cursor": cursor,
            "scanned": len(rows),
        }

    def requeue_reviewed_attempt(self, candidate: dict[str, Any], *, decision_id: str) -> bool:
        """Requeue one explicitly reviewed, unchanged candidate; never grants credit."""
        from openreceive.storage.maintenance import repair_candidate, repair_decision

        self.assert_supported_schema()
        decision = repair_decision(decision_id)
        payment_hash = normalize_payment_hash(candidate["payment_hash"])
        record = self.find_by_payment_hash(payment_hash)
        if record is None:
            return False
        payments, meta = self.tables.payments, self.tables.meta
        with self._reference_transaction(record.reference) as connection:
            row = connection.execute(
                select(payments).where(payments.c.payment_hash == payment_hash)
            ).first()
            if (
                row is None
                or row.status != candidate["status"]
                or to_unix(row.updated_at) != candidate["updated_at"]
            ):
                return False
            current = repair_candidate(self._record(row._mapping), to_unix(row.updated_at))
            if current != candidate:
                return False
            audit_key = "repair:" + payment_hash + ":" + decision
            if (
                connection.execute(select(meta.c.key).where(meta.c.key == audit_key)).first()
                is not None
            ):
                return False
            now = self._clock()
            audit = {**current, "decision_id": decision, "requeued_at": now}
            connection.execute(
                meta.insert().values(
                    key=audit_key,
                    value=json.dumps(audit),
                    rev=0,
                )
            )
            connection.execute(
                payments.update()
                .where(
                    payments.c.payment_hash == payment_hash,
                    payments.c.status == row.status,
                    payments.c.updated_at == row.updated_at,
                )
                .values(
                    status="pending", status_reason="operator_requeued", updated_at=to_datetime(now)
                )
            )
        return True

    # ------------------------------------------------------------ schema

    def assert_supported_schema(self) -> None:
        """One probe per repository, on first use (never at import or boot, so
        migrations and shells run against an unmigrated database): a missing
        meta table is diagnosed as "the migration never ran here"; a database
        written by a NEWER library is refused."""
        if self._schema_checked:
            return
        meta = self.tables.meta
        if not inspect(self.engine).has_table(meta.name):
            raise SchemaError(
                f"The {meta.name} table does not exist — the OpenReceive tables have not been migrated "
                "in this database. Apply `openreceive scaffold payments --sql --dialect <dialect>` "
                "(or the Django migration) through your normal workflow. " + STORAGE_GUIDE_URL
            )
        with self.engine.connect() as connection:
            stored = connection.execute(
                select(meta.c.value).where(meta.c.key == SCHEMA_VERSION_KEY)
            ).scalar()
        if stored is not None:
            try:
                version = int(str(stored).strip())
            except ValueError:
                version = None
            if version is not None and version > PAYMENTS_SCHEMA_VERSION:
                raise SchemaError(
                    f"{meta.name} reports openreceive schema version {version}, newer than this library's "
                    f"{PAYMENTS_SCHEMA_VERSION}. Upgrade openreceive before serving this database."
                )
        self._schema_checked = True

    def create_tables(self) -> None:
        """Test/dev convenience: create both tables and seed the version marker.
        Production hosts run the rendered DDL or the Django migration."""
        from openreceive.storage.sql.ddl import seed_sql

        self.tables.metadata.create_all(self.engine)
        with self.engine.begin() as connection:
            connection.execute(text(seed_sql(self.dialect, self.tables.meta.name)))

    # --------------------------------------------------------- internals

    @contextmanager
    def _reference_transaction(self, reference: str) -> Iterator[Connection]:
        if self.dialect in ("mysql", "mariadb"):
            with self.engine.connect() as connection:
                name = "openreceive:" + hashlib.sha256(reference.encode("utf-8")).hexdigest()[:40]
                acquired = connection.execute(
                    text("SELECT GET_LOCK(:name, :timeout)"),
                    {"name": name, "timeout": MYSQL_LOCK_TIMEOUT_SECONDS},
                ).scalar()
                connection.commit()
                if acquired != 1:
                    raise LockTimeout("Timed out taking the OpenReceive lock for this reference.")
                try:
                    with connection.begin():
                        yield connection
                finally:
                    connection.execute(text("SELECT RELEASE_LOCK(:name)"), {"name": name})
                    connection.commit()
            return
        with self.engine.begin() as connection:
            if self.dialect == "postgresql":
                connection.execute(
                    text("SELECT pg_advisory_xact_lock(hashtextextended(:reference, :seed))"),
                    {"reference": reference, "seed": ADVISORY_LOCK_SEED},
                )
            yield connection

    def _rows_for_reference(self, connection: Connection, reference: str) -> list[PaymentRecord]:
        payments = self.tables.payments
        query = (
            select(payments)
            .where(payments.c.reference == reference)
            .order_by(payments.c.created_at.desc(), payments.c.payment_hash.desc())
        )
        return [self._record(row._mapping) for row in connection.execute(query)]

    def _find_by_hash(self, connection: Connection, payment_hash: str) -> PaymentRecord | None:
        payments = self.tables.payments
        row = connection.execute(
            select(payments).where(payments.c.payment_hash == payment_hash)
        ).first()
        return None if row is None else self._record(row._mapping)

    @staticmethod
    def _record(row: Any) -> PaymentRecord:
        status = str(row["status"])
        if status not in ATTEMPT_STATUSES:
            raise ValueError(f"Unexpected openreceive_payments status: {status}")
        return PaymentRecord(
            reference=str(row["reference"]),
            payment_hash=str(row["payment_hash"]),
            status=status,
            status_reason=row["status_reason"],
            paid_at=None if row["paid_at"] is None else to_unix(row["paid_at"]),
            expires_at=to_unix(row["expires_at"]),
            created_at=to_unix(row["created_at"]),
            checkout=_json_column(row["checkout_data"], "checkout_data", str(row["payment_hash"])),
            swap_data=None
            if row["swap_data"] is None
            else _json_column(row["swap_data"], "swap_data", str(row["payment_hash"])),
        )

    @staticmethod
    def _reconcilable(row: Any) -> ReconcilableAttempt:
        return ReconcilableAttempt(
            payment_hash=str(row.payment_hash),
            created_at=to_unix(row.created_at),
            created_at_source=_json_column(
                row.checkout_data, "checkout_data", str(row.payment_hash)
            ).get("created_at_source", "host"),
            expires_at=settlement_expires_at(
                _json_column(row.checkout_data, "checkout_data", str(row.payment_hash)),
                str(row.payment_hash),
            ),
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
