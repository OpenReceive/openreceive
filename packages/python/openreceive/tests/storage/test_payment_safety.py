from __future__ import annotations

import json

import pytest

from openreceive.nwc.errors import redact_secrets
from openreceive.server import Service
from openreceive.server.reconcile import Reconciler
from openreceive.storage import PaymentInsert
from openreceive.testing import FakeWallet
from tests.conftest import load_vector
from tests.storage.test_sql_repository import H1, checkout


class HistoryWallet(FakeWallet):
    def __init__(self, rows, page_size=20):
        super().__init__()
        self.rows = rows
        self.page_size = page_size
        self.calls = []

    def list_transactions(self, request):
        self.calls.append(dict(request))
        offset = request.get("offset", 0)
        return {"transactions": self.rows[offset : offset + self.page_size]}


def reconciler(repository, clock, wallet, paid):
    return Reconciler(
        service=Service(
            wallet, price_provider=False, swap_providers=[], clock=lambda: clock["now"]
        ),
        repository=repository,
        on_paid=paid.append,
        clock=lambda: clock["now"],
    )


@pytest.mark.parametrize(
    "case", load_vector("reconcile-progress.json")["vectors"], ids=lambda row: row["name"]
)
def test_durable_progress_vectors(case, repository, clock):
    now = clock["now"]
    if "lease_seconds" in case:
        old = repository.claim_reconcile_gate(
            now=now, interval_seconds=2, lease_seconds=case["lease_seconds"]
        )
        newer = repository.claim_reconcile_gate(now=now + case["new_claim_at"], interval_seconds=2)
        assert newer is not None
        assert (
            repository.checkpoint_reconcile_gate(
                old, old["scheduler"], now=now + case["new_claim_at"]
            )
            is case["expected_old_checkpoint"]
        )
        return
    count = case.get("pending_count", 1)
    paid_hash = f"{count:064x}"
    for i in range(count):
        h = f"{i + 1:064x}"
        repository.commit_attempt(
            PaymentInsert(f"progress-{i}", h, checkout(f"progress-{i}", h, now, now + 600))
        )
    total = case.get("history_rows", 1)
    rows = [
        {"payment_hash": f"{10000 + i:064x}", "created_at": now, "settled_at": now + 1}
        for i in range(total)
    ]
    if "expected_closed" not in case:
        rows[case.get("paid_index", 0) if "history_rows" in case else 0]["payment_hash"] = paid_hash
    wallet = HistoryWallet(rows, case.get("page_size", 20))
    paid = []
    clock["now"] = now + 1600
    for _ in range(case.get("max_passes", 3)):
        # Recreate the reconciler on every slice; only DB state carries progress.
        before = len(wallet.calls)
        reconciler(repository, clock, wallet, paid).reconcile()
        assert len(wallet.calls) - before <= 50
        clock["now"] += 12
    record = repository.find_by_payment_hash(paid_hash)
    if "expected_closed" in case:
        assert record.status == "pending"
    else:
        assert record.status == "settled" and len(paid) == 1
    # Every persisted checkpoint is bounded; no raw wallet transaction/preimage.
    claim = repository.claim_reconcile_gate(now=clock["now"], interval_seconds=2)
    assert claim is not None
    assert (
        len(json.dumps(claim).encode())
        <= load_vector("reconcile-progress.json")["max_checkpoint_bytes"]
    )
    assert "settled_at" not in json.dumps(claim)


@pytest.mark.parametrize(
    "case", load_vector("secret-redaction.json")["vectors"], ids=lambda row: row["name"]
)
def test_secret_redaction_vectors(case):
    assert redact_secrets(case["input"]) == case["expected"]


def test_disabled_http_opportunism_does_not_disable_worker_and_failed_delivery_is_omitted(
    repository, clock
):
    now = clock["now"]
    repository.commit_attempt(PaymentInsert("retry", H1, checkout("retry", H1, now, now + 600)))
    wallet = HistoryWallet([{"payment_hash": H1, "settled_at": now + 2}])
    paid = []
    worker = reconciler(repository, clock, wallet, paid)
    worker.opportunistic_reconcile = False
    assert worker.maybe_reconcile()["reason"] == "disabled"
    assert not wallet.calls
    worker._on_paid = lambda _: (_ for _ in ()).throw(RuntimeError("host rollback"))
    assert worker.reconcile() == []
    assert repository.find_by_payment_hash(H1).status == "pending"
    clock["now"] += 12
    worker._on_paid = paid.append
    assert worker.reconcile()[0]["status"] == "settled"
    assert len(paid) == 1
    assert (
        worker.handle_notification(
            {
                "notification_type": "payment_received",
                "notification": {"payment_hash": H1, "settled_at": now + 2},
            }
        )
        == "scanned"
    )
    assert len(paid) == 1


@pytest.mark.parametrize(
    "case",
    load_vector("attempt-reconciliation.json")["snapshot_cases"],
    ids=lambda row: row["name"],
)
def test_persisted_snapshot_deadline_vectors(case, repository, clock):
    from openreceive.payments.reconciliation import transition
    from tests.storage.test_sql_repository import swap_data

    repository.commit_attempt(
        PaymentInsert(
            "snapshot",
            H1,
            checkout("snapshot", H1, case["created_at"], case["wallet_expires_at"]),
            swap_data=swap_data("USDT_TRON", case["instruction_expires_at"]),
        )
    )
    attempt = repository.find_pending_attempt(H1)
    assert attempt.expires_at == case["wallet_expires_at"]
    assert (
        transition(
            expires_at=attempt.expires_at, status="not_found", observed_at=case["observed_at"]
        )
        == case["expected"]
    )


def test_positive_finality_survives_a_later_invalid_page(repository, clock):
    now = clock["now"]
    second = "2" * 64
    for reference, hash_value in (("paid-first", H1), ("unresolved", second)):
        repository.commit_attempt(
            PaymentInsert(reference, hash_value, checkout(reference, hash_value, now, now + 600))
        )
    rows = [{"payment_hash": H1, "settled_at": now + 500}]
    rows.extend({"payment_hash": f"{100 + index:064x}"} for index in range(19))
    wallet = HistoryWallet(rows)
    wallet.list_transactions = lambda request: {
        "transactions": rows if request["offset"] == 0 else [None, "invalid"]
    }
    clock["now"] += 1600
    paid = []
    worker = reconciler(repository, clock, wallet, paid)
    assert worker.gated_reconcile()["reason"] == "scan_failed"
    assert repository.find_by_payment_hash(H1).status == "settled"
    assert repository.find_by_payment_hash(second).status == "pending"
    assert len(paid) == 1


@pytest.mark.parametrize("via_notification", [False, True])
@pytest.mark.parametrize("observed_at", [2600, 2900])
def test_late_swap_settlement_uses_saved_wallet_deadline(
    repository, clock, via_notification, observed_at
):
    from tests.storage.test_sql_repository import swap_data

    # Persisted pre-upgrade snapshots omit provenance; the wider scan must still
    # find a payout at 2600, before the actual wallet expiry at 2800.
    repository.commit_attempt(
        PaymentInsert(
            "late-swap",
            H1,
            checkout("late-swap", H1, 1000, 2800),
            swap_data=swap_data("USDT_TRON", 1600),
        )
    )
    clock["now"] = 2500
    wallet = HistoryWallet([])
    paid = []
    worker = reconciler(repository, clock, wallet, paid)
    worker.reconcile()
    assert repository.find_by_payment_hash(H1).status == "pending"
    clock["now"] = observed_at
    row = {"payment_hash": H1, "created_at": 1000, "expires_at": 2800, "settled_at": 2600}
    wallet.rows.append(row)
    event = {"notification_type": "payment_received", "notification": row}
    if via_notification:
        assert worker.handle_notification(event) == "settled"
    else:
        worker.reconcile()
    assert repository.find_by_payment_hash(H1).status == "settled"
    worker.handle_notification(event)
    clock["now"] += 12
    worker.reconcile()
    assert len(paid) == 1
    assert repository.find_by_payment_hash(H1).swap_data is not None


def test_late_page_cannot_apply_absence_after_request_deadline(monkeypatch):
    from openreceive.server import reconcile_scan

    timer = {"now": 0.0}
    monkeypatch.setattr(reconcile_scan.time, "monotonic", lambda: timer["now"])
    wallet = HistoryWallet([])

    def slow_page(_request):
        timer["now"] = 11.0
        return {"transactions": []}

    wallet.list_transactions = slow_page
    service = Service(wallet, price_provider=False, swap_providers=[])
    window = reconcile_scan.new_window(
        [{"payment_hash": H1, "created_at": 1000, "expires_at": 1600}], 3000, 60
    )
    assert reconcile_scan.scan_slice(service, window, max_pages=50, deadline=9.0) == (
        [],
        False,
        False,
    )
    assert window["view"] == "default" and window["offset"] == 0
