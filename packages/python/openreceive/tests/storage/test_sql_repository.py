from __future__ import annotations

import threading
from typing import Any

import pytest
from sqlalchemy import Engine, text

from openreceive.storage import (
    AttemptConflict,
    PaymentInsert,
    PaymentSettlement,
    ReconciliationTransition,
    SchemaError,
    SettlementRecord,
    selected_for,
)
from openreceive.storage.sql import SqlPaymentRepository, payments_schema_sql
from tests.conftest import load_vector


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


def swap_data(asset: str, expires_at: int) -> dict[str, Any]:
    return {
        "version": 1,
        "provider_order": {
            "provider": "fixedfloat",
            "provider_order_id": "ff-1",
            "provider_token": "server-only",
            "pay_in_asset": asset,
            "expires_at": expires_at,
            "state": "awaiting_deposit",
        },
    }


H1, H2, H3 = "1" * 64, "2" * 64, "3" * 64


def test_commit_then_read_back(repository: SqlPaymentRepository, clock: dict[str, int]) -> None:
    now = clock["now"]
    record = repository.commit_attempt(
        PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600), client_ip="203.0.113.9")
    )
    assert record.status == "pending"
    assert record.expires_at == now + 600 and record.created_at == now
    assert record.checkout["bolt11"].startswith("lnbc")
    rows = repository.list_for_reference("ord-1")
    assert [row.payment_hash for row in rows] == [H1]
    # Idempotent for a repeated hash; another reference cannot claim it.
    assert (
        repository.commit_attempt(
            PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600))
        ).payment_hash
        == H1
    )
    with pytest.raises(AttemptConflict):
        repository.commit_attempt(PaymentInsert("ord-2", H1, checkout("ord-2", H1, now, now + 600)))
    assert repository.count_attempts_from_ip("203.0.113.9", now - 3600) == 1
    assert repository.count_attempts_from_ip("203.0.113.9", now + 1) == 0
    assert repository.list_reconcilable_attempts()[0].payment_hash == H1
    assert repository.find_pending_attempt(H1) is not None
    assert repository.find_pending_attempt(H2) is None


def test_live_same_rail_conflicts_and_near_expiry_supersedes(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600)))
    with pytest.raises(AttemptConflict, match="already in progress"):
        repository.commit_attempt(PaymentInsert("ord-1", H2, checkout("ord-1", H2, now, now + 600)))
    # A swap attempt is another rail: allowed alongside the Lightning one.
    repository.commit_attempt(
        PaymentInsert(
            "ord-1",
            H3,
            checkout("ord-1", H3, now, now + 1800),
            swap_data=swap_data("USDT_TRON", now + 900),
        )
    )
    assert repository.list_for_reference("ord-1")[0].expires_at == now + 900  # provider expiry wins
    # Within the reuse buffer the live Lightning row is superseded, not closed.
    clock["now"] = now + 570
    repository.commit_attempt(
        PaymentInsert("ord-1", H2, checkout("ord-1", H2, now + 570, now + 1170))
    )
    by_hash = {row.payment_hash: row for row in repository.list_for_reference("ord-1")}
    assert by_hash[H1].status == "pending" and by_hash[H1].status_reason == "superseded"
    assert by_hash[H2].status == "pending"
    # swap_data never reaches repr or the public dict.
    assert "server-only" not in repr(by_hash[H3])
    assert "swap_data" not in by_hash[H3].public_dict()


def test_settlement_is_write_once_and_fulfills_first_only(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600)))
    repository.commit_attempt(
        PaymentInsert(
            "ord-1",
            H3,
            checkout("ord-1", H3, now, now + 1800),
            swap_data=swap_data("SOL_SOL", now + 900),
        )
    )
    fulfilled: list[PaymentSettlement] = []

    def fulfill(settlement: PaymentSettlement) -> None:
        # Backend-neutral (tests/django re-runs this contract): the SQL
        # repository's in-transaction Connection is asserted in test_app.py.
        assert settlement.reference == "ord-1"
        fulfilled.append(settlement)

    assert (
        repository.record_settlement(
            SettlementRecord(H1, now + 10, {"observed_at": now + 10}), fulfill
        )
        is True
    )
    # Replayed delivery: recorded already, never fulfilled twice.
    assert repository.record_settlement(SettlementRecord(H1, now + 10), fulfill) is False
    # A genuine second payment on a sibling attempt is recorded, not fulfilled.
    assert repository.record_settlement(SettlementRecord(H3, now + 20), fulfill) is False
    assert repository.record_settlement(SettlementRecord("f" * 64, now), fulfill) is False
    by_hash = {row.payment_hash: row for row in repository.list_for_reference("ord-1")}
    assert (
        by_hash[H1].status == "settled"
        and by_hash[H1].paid_at == now + 10
        and by_hash[H1].status_reason is None
    )
    assert by_hash[H3].status == "settled" and by_hash[H3].status_reason == "duplicate_settlement"
    assert [item.reference for item in fulfilled] == ["ord-1"]
    assert fulfilled[0].details == {"observed_at": now + 10}
    with pytest.raises(AttemptConflict, match="already paid"):
        repository.commit_attempt(PaymentInsert("ord-1", H2, checkout("ord-1", H2, now, now + 600)))
    # Terminal rows leave the reconcile set; a settled row is never overwritten.
    assert repository.list_reconcilable_attempts() == []
    repository.record_reconciliation(
        ReconciliationTransition(H1, "expired", now + 5000, "not_found_after_expiry")
    )
    assert repository.find_by_payment_hash(H1).status == "settled"  # type: ignore[union-attr]


def test_fulfill_failure_rolls_the_settlement_back(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600)))

    def fulfill(settlement: PaymentSettlement) -> None:
        raise RuntimeError("host fulfillment failed")

    with pytest.raises(RuntimeError):
        repository.record_settlement(SettlementRecord(H1, now + 10), fulfill)
    assert repository.find_by_payment_hash(H1).status == "pending"  # type: ignore[union-attr]
    # The next pass can deliver it.
    assert repository.record_settlement(SettlementRecord(H1, now + 10), lambda _s: None) is True


def test_record_reconciliation_only_touches_pending_rows(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600)))
    repository.record_reconciliation(
        ReconciliationTransition(H1, "attention", now + 2000, "unsettled_after_expiry")
    )
    row = repository.find_by_payment_hash(H1)
    assert (
        row is not None
        and row.status == "attention"
        and row.status_reason == "unsettled_after_expiry"
    )
    repository.record_reconciliation(
        ReconciliationTransition(H1, "expired", now + 3000, "not_found_after_expiry")
    )
    assert repository.find_by_payment_hash(H1).status == "attention"  # type: ignore[union-attr]
    with pytest.raises(ValueError):
        repository.record_reconciliation(ReconciliationTransition(H1, "settled", now, "nope"))


def test_reconcile_gate_is_a_durable_cas(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    now = clock["now"]
    assert repository.claim_reconcile_gate(now=now, interval_seconds=2) is True
    assert repository.claim_reconcile_gate(now=now + 1, interval_seconds=2) is False
    assert repository.claim_reconcile_gate(now=now + 2, interval_seconds=2) is True
    # A claim stamped far in the future is a rewound clock, not a fresh claim.
    assert repository.claim_reconcile_gate(now=now + 1000, interval_seconds=2) is True
    assert repository.claim_reconcile_gate(now=now + 1000 - 120, interval_seconds=2) is True


def test_selection_rule_over_the_rows(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600)))
    rows = repository.list_for_reference("ord-1")
    assert selected_for(rows, action="checkout.create", now=now).payment_hash == H1  # type: ignore[union-attr]
    assert selected_for(rows, action="swap.create", now=now, pay_in_asset="SOL_SOL") is None
    assert selected_for(rows, action="payment.check", now=now, payment_hash=H1).payment_hash == H1  # type: ignore[union-attr]
    assert selected_for(rows, action="payment.check", now=now, payment_hash=H2) is None
    assert selected_for(rows, action="swap.read", now=now) is None
    # Inside the reuse buffer the live row is not offered again.
    assert selected_for(rows, action="checkout.create", now=now + 560) is None


def test_rate_limit_window_counts_on_inserted_at(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    # The shared rate-limit-window vector: the budget windows on the immutable
    # inserted_at stamp — created_at is the wallet's clock, updated_at moves.
    vector = load_vector("rate-limit-window.json")
    assert vector["column"] == "inserted_at"
    for index, case in enumerate(vector["cases"]):
        attempt = case["attempt"]
        payment_hash = f"{index:064x}"
        reference = f"rlw-{index}"
        clock["now"] = attempt["inserted_at"]
        repository.commit_attempt(
            PaymentInsert(
                reference,
                payment_hash,
                checkout(
                    reference, payment_hash, attempt["created_at"], attempt["created_at"] + 600
                ),
                client_ip=f"198.51.100.{index}",
            )
        )
        if attempt["updated_at"] != attempt["inserted_at"]:
            # A later status transition moves updated_at only.
            repository.record_reconciliation(
                ReconciliationTransition(
                    payment_hash, "expired", attempt["updated_at"], "not_found_after_expiry"
                )
            )
        counted = (
            repository.count_attempts_from_ip(
                f"198.51.100.{index}", case["now"] - case["window_seconds"]
            )
            == 1
        )
        assert counted == case["expected"]["counted"], case["name"]


def test_schema_guard(engine: Engine) -> None:
    unmigrated = SqlPaymentRepository(
        engine, table_name="orp_missing", meta_table_name="orm_missing"
    )
    with pytest.raises(SchemaError, match="have not been migrated"):
        unmigrated.list_reconcilable_attempts()
    newer = SqlPaymentRepository(engine, table_name="orp_newer", meta_table_name="orm_newer")
    newer.create_tables()
    try:
        with engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE orm_newer SET value = '99' WHERE "
                    + ("`key`" if engine.dialect.name == "mysql" else "key")
                    + " = 'schema_version'"
                )
            )
        with pytest.raises(SchemaError, match="newer than this library"):
            newer.list_reconcilable_attempts()
    finally:
        with engine.begin() as connection:
            connection.execute(text("DROP TABLE IF EXISTS orp_newer"))
            connection.execute(text("DROP TABLE IF EXISTS orm_newer"))


def test_concurrent_commits_for_one_reference_serialize(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    """Two threads race to mint for one reference: exactly one row wins, the
    other is refused as the live same-rail conflict (or returns the same row on
    a repeated hash) — never two live attempts and never a driver error."""
    now = clock["now"]
    outcomes: list[str] = []
    lock = threading.Lock()
    start = threading.Barrier(8)

    def worker(index: int) -> None:
        payment_hash = f"{index + 100:064x}"
        start.wait()
        try:
            repository.commit_attempt(
                PaymentInsert(
                    "ord-race", payment_hash, checkout("ord-race", payment_hash, now, now + 600)
                )
            )
            outcome = "committed"
        except AttemptConflict:
            outcome = "conflict"
        with lock:
            outcomes.append(outcome)

    threads = [threading.Thread(target=worker, args=(index,)) for index in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert sorted(outcomes) == ["committed"] + ["conflict"] * 7
    rows = repository.list_for_reference("ord-race")
    assert len(rows) == 1 and rows[0].status == "pending"


def test_concurrent_settlement_fulfills_exactly_once(
    repository: SqlPaymentRepository, clock: dict[str, int]
) -> None:
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("ord-1", H1, checkout("ord-1", H1, now, now + 600)))
    wins: list[bool] = []
    fulfilled: list[str] = []
    lock = threading.Lock()
    start = threading.Barrier(6)

    def worker() -> None:
        start.wait()
        won = repository.record_settlement(
            SettlementRecord(H1, now + 5), lambda s: fulfilled.append(s.payment_hash)
        )
        with lock:
            wins.append(won)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)
    assert wins.count(True) == 1 and fulfilled == [H1]


def test_schema_sql_renders_per_dialect() -> None:
    for dialect in ("postgres", "sqlite", "mysql"):
        sql = payments_schema_sql(dialect)
        assert "CREATE TABLE openreceive_payments" in sql
        assert "openreceive_meta" in sql
        assert "'schema_version', '1', 0" in sql
        assert "status IN ('pending', 'settled', 'expired', 'failed', 'attention')" in sql
    assert "ON CONFLICT (key) DO NOTHING" in payments_schema_sql("postgres")
    assert "INSERT OR IGNORE" in payments_schema_sql("sqlite")
    assert "INSERT IGNORE" in payments_schema_sql("mysql")
    assert "payment_hash ~ '^[0-9a-f]{64}$'" in payments_schema_sql("postgresql")
    with pytest.raises(ValueError):
        payments_schema_sql("oracle")
