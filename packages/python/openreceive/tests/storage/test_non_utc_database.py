"""A database that is not set to UTC: every session here runs in Asia/Tokyo
(UTC+9) whatever the server was started with, with a host process in another
zone again. This engine writes naive UTC into DateTime columns, so a session
offset must change nothing; the expiry boundaries below would catch a nine hour
shift in either direction.

Runs only against real servers (OPENRECEIVE_TEST_PGSQL_URL /
OPENRECEIVE_TEST_MYSQL_URL). tools/ci/deployment-edge-tests.sh also runs it
against servers started in that zone."""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import Engine, event, text

from openreceive.payments import ATTEMPT_EXPIRY_GRACE_SECONDS as GRACE
from openreceive.server.reconcile import Reconciler
from openreceive.server.service import Service
from openreceive.storage import PaymentInsert, SettlementRecord
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing.fake_wallet import FakeWallet
from tests.storage.conftest import _engine_for

NON_UTC_BACKENDS = [
    backend
    for backend, variable in (
        ("postgres", "OPENRECEIVE_TEST_PGSQL_URL"),
        ("mysql", "OPENRECEIVE_TEST_MYSQL_URL"),
    )
    if os.environ.get(variable)
]

NOW = 1_794_210_000
H1, H2, H3 = "1" * 64, "2" * 64, "3" * 64

pytestmark = pytest.mark.skipif(
    not NON_UTC_BACKENDS, reason="needs a real Postgres or MySQL test database"
)


def tokyo_engine(backend: str, tmp_path: Path) -> Engine:
    engine = _engine_for(backend, tmp_path)

    @event.listens_for(engine, "connect")
    def set_zone(dbapi_connection: Any, _record: Any) -> None:
        statement = (
            "SET TIME ZONE 'Asia/Tokyo'" if backend == "postgres" else "SET time_zone = '+09:00'"
        )
        cursor = dbapi_connection.cursor()
        cursor.execute(statement)
        cursor.close()
        dbapi_connection.commit()

    return engine


@pytest.fixture(params=NON_UTC_BACKENDS or ["postgres"])
def repository(
    request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[SqlPaymentRepository]:
    monkeypatch.setenv("TZ", "America/New_York")
    time.tzset()
    engine = tokyo_engine(str(request.param), tmp_path)
    suffix = uuid.uuid4().hex[:8]
    repository = SqlPaymentRepository(
        engine,
        table_name=f"openreceive_payments_{suffix}",
        meta_table_name=f"openreceive_meta_{suffix}",
        clock=lambda: NOW,
    )
    repository.create_tables()
    yield repository
    with engine.begin() as connection:
        connection.execute(text(f"DROP TABLE IF EXISTS {repository.tables.payments.name}"))
        connection.execute(text(f"DROP TABLE IF EXISTS {repository.tables.meta.name}"))
    engine.dispose()
    monkeypatch.delenv("TZ", raising=False)
    time.tzset()


def checkout(reference: str, payment_hash: str, created_at: int, expires_at: int) -> dict[str, Any]:
    return {
        "reference": reference,
        "payment_hash": payment_hash,
        "bolt11": f"lnbc{payment_hash[:8]}",
        "amount_msats": 1000,
        "created_at": created_at,
        "expires_at": expires_at,
        "fiat_quote": None,
    }


def utc_text(unix_seconds: int) -> str:
    return datetime.fromtimestamp(unix_seconds, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def stored_text(repository: SqlPaymentRepository, column: str, payment_hash: str) -> str:
    """The raw wall clock the column holds, without any driver's interpretation."""
    table = repository.tables.payments.name
    if repository.engine.dialect.name == "postgresql":
        sql = f"SELECT to_char({column}, 'YYYY-MM-DD HH24:MI:SS') FROM {table} WHERE payment_hash = :h"
    else:
        sql = f"SELECT DATE_FORMAT({column}, '%Y-%m-%d %H:%i:%s') FROM {table} WHERE payment_hash = :h"
    with repository.engine.connect() as connection:
        return str(connection.execute(text(sql), {"h": payment_hash}).scalar_one())


def test_columns_hold_utc_wall_clock_in_a_tokyo_session(repository: SqlPaymentRepository) -> None:
    created = NOW - 60
    expires = NOW + 540
    record = repository.commit_attempt(
        PaymentInsert("ord", H1, checkout("ord", H1, created, expires), client_ip="203.0.113.1")
    )
    assert (record.created_at, record.expires_at) == (created, expires)
    assert stored_text(repository, "expires_at", H1) == utc_text(expires)
    assert stored_text(repository, "created_at", H1) == utc_text(created)
    assert stored_text(repository, "inserted_at", H1) == utc_text(NOW)
    # And the session really is ahead: the same column read through the session
    # clock would be nine hours off if anything treated it as session-local.
    assert repository.list_for_reference("ord")[0].expires_at == expires


def test_paid_at_round_trips_exactly(repository: SqlPaymentRepository) -> None:
    repository.commit_attempt(PaymentInsert("ord", H1, checkout("ord", H1, NOW, NOW + 600)))
    paid_at = NOW + 123
    repository.record_settlement(
        SettlementRecord(payment_hash=H1, paid_at=paid_at), lambda settlement: None
    )
    record = repository.find_by_payment_hash(H1)
    assert record is not None
    assert record.paid_at == paid_at
    assert stored_text(repository, "paid_at", H1) == utc_text(paid_at)


def test_expiry_closes_on_the_clock_nine_hours_from_nowhere(
    repository: SqlPaymentRepository,
) -> None:
    wallet = FakeWallet(clock=lambda: NOW)
    service = Service(wallet, price_provider=False, swap_providers=[], clock=lambda: NOW)
    reconciler = Reconciler(
        service=service,
        repository=repository,
        on_paid=lambda settlement: None,
        after_paid=None,
        opportunistic_reconcile=True,
        clock=lambda: NOW,
    )
    past = NOW - GRACE - 1
    in_grace = NOW - GRACE + 120
    live = NOW + 300
    for reference, payment_hash, expires in (("a", H1, past), ("b", H2, in_grace), ("c", H3, live)):
        repository.commit_attempt(
            PaymentInsert(
                reference, payment_hash, checkout(reference, payment_hash, expires - 600, expires)
            )
        )
    reconciler.reconcile(overlap_seconds=60)
    statuses = {
        record.payment_hash[0]: record.status
        for reference in ("a", "b", "c")
        for record in repository.list_for_reference(reference)
    }
    assert statuses == {"1": "expired", "2": "pending", "3": "pending"}


def test_the_scan_window_finds_a_settled_invoice(repository: SqlPaymentRepository) -> None:
    """The walk's window comes from created_at read back from the database: a nine
    hour offset there would filter this invoice out of the history page."""
    wallet = FakeWallet(clock=lambda: NOW)
    service = Service(wallet, price_provider=False, swap_providers=[], clock=lambda: NOW)
    fulfilled: list[str] = []
    reconciler = Reconciler(
        service=service,
        repository=repository,
        on_paid=lambda settlement: fulfilled.append(settlement.reference),
        after_paid=None,
        opportunistic_reconcile=True,
        clock=lambda: NOW,
    )
    minted = wallet.make_invoice({"amount_msats": 1000, "expiry": 600})
    payment_hash = str(minted["payment_hash"])
    repository.commit_attempt(
        PaymentInsert(
            "window",
            payment_hash,
            checkout("window", payment_hash, NOW, int(minted["expires_at"])),
        )
    )
    wallet.settle_invoice({"payment_hash": payment_hash})
    reconciler.reconcile(overlap_seconds=60)
    record = repository.find_by_payment_hash(payment_hash)
    assert record is not None and record.status == "settled"
    assert fulfilled == ["window"]
