from __future__ import annotations

import json
import time

import pytest

from openreceive.nwc.errors import WalletError, redact_secrets
from openreceive.server import Service
from openreceive.server.reconcile import Reconciler
from openreceive.storage import PaymentInsert
from openreceive.testing import FakeWallet
from tests.conftest import load_vector
from tests.storage.test_sql_repository import H1, H2, checkout


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


PROGRESS = load_vector("reconcile-progress.json")
# The deadline-cut vectors run once per clock source, in their own test below.
DEADLINE_CASES = [
    (case, source)
    for case in PROGRESS["vectors"]
    if "pages_before_deadline" in case
    for source in case.get("created_at_sources", ["wallet"])
]


@pytest.mark.parametrize(
    "case",
    [case for case in PROGRESS["vectors"] if "pages_before_deadline" not in case],
    ids=lambda row: row["name"],
)
def test_durable_progress_vectors(case, repository, clock):
    now = clock["now"]
    if "host_created_at" in case:
        host_clock_attempt_gets_its_own_window(case, repository, clock)
        return
    if "mixed_clock_sources" in case:
        mixed_batches_cannot_skip_a_host_timed_attempt(case, repository, clock)
        return
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
    if "coverage_started_at" in case:
        clock["now"] = case["coverage_started_at"]
        repository.commit_attempt(
            PaymentInsert(
                "coverage", H1, checkout("coverage", H1, case["created_at"], case["expires_at"])
            )
        )
        wallet = HistoryWallet([])

        def crossing_deadline(request):
            clock["now"] = max(clock["now"], case["completed_at"])
            return {"transactions": []}

        wallet.list_transactions = crossing_deadline
        engine = reconciler(repository, clock, wallet, [])
        engine.reconcile()
        assert repository.find_by_payment_hash(H1).status == "pending"
        clock["now"] = case["next_scan_at"]
        engine.reconcile()
        assert repository.find_by_payment_hash(H1).status == "expired"
        return
    count = case.get("pending_count", 1)
    paid_hash = f"{count:064x}"
    for i in range(count):
        h = f"{i + 1:064x}"
        created = now + i * case.get("creation_stride", 0)
        saved = checkout(f"progress-{i}", h, created, created + 600)
        saved["created_at_source"] = "wallet"
        repository.commit_attempt(PaymentInsert(f"progress-{i}", h, saved))
    total = case.get("history_rows", 1)
    rows = [
        {"payment_hash": f"{10000 + i:064x}", "created_at": now, "settled_at": now + 1}
        for i in range(total)
    ]
    if "expected_closed" not in case:
        rows[case.get("paid_index", 0) if "history_rows" in case else 0]["payment_hash"] = paid_hash
    wallet = HistoryWallet(rows, case.get("page_size", 20))
    if "failed_cohorts" in case:
        normal_list = wallet.list_transactions

        def list_with_failed_history(request):
            if request["from"] < now + case["paid_index"] * case["creation_stride"] - 60:
                wallet.calls.append(dict(request))
                raise RuntimeError("historical cohort unavailable")
            return normal_list(request)

        wallet.list_transactions = list_with_failed_history
    paid = []
    failed_fulfillments = case.get("failed_fulfillments", 0)

    def fulfill(event):
        nonlocal failed_fulfillments
        if failed_fulfillments:
            failed_fulfillments -= 1
            raise RuntimeError("host rollback")
        paid.append(event)

    clock["now"] = now + 1600
    for pass_index in range(case.get("max_passes", 3)):
        for arrival in range(case.get("arrivals_per_pass", 0)):
            ref = f"arrival-{pass_index}-{arrival}"
            h = f"{50000 + pass_index * case['arrivals_per_pass'] + arrival:064x}"
            saved = checkout(ref, h, clock["now"], clock["now"] + 600)
            saved["created_at_source"] = "wallet"
            repository.commit_attempt(PaymentInsert(ref, h, saved))
        # Recreate the reconciler on every slice; only DB state carries progress.
        before = len(wallet.calls)
        engine = reconciler(repository, clock, wallet, paid)
        engine._on_paid = fulfill
        engine.reconcile()
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
    ("case", "source"),
    DEADLINE_CASES,
    ids=[f"{case['name']} ({source}-timed)" for case, source in DEADLINE_CASES],
)
def test_deadline_cut_vectors(case, source, repository, clock, monkeypatch):
    from openreceive.server import reconcile

    # A short real slice: the cut page waits out the deadline like the client.
    monkeypatch.setattr(reconcile, "RECONCILE_SCAN_TIMEOUT_SECONDS", 0.3)
    now = clock["now"]
    saved = checkout("deadline-cut", H1, now, now + 600)
    saved["created_at_source"] = source
    repository.commit_attempt(PaymentInsert("deadline-cut", H1, saved))
    rows = [
        {"payment_hash": f"{10000 + i:064x}", "created_at": now, "settled_at": now + 1}
        for i in range(case["history_rows"])
    ]
    rows[case["paid_index"]]["payment_hash"] = H1
    wallet = HistoryWallet(rows, case["page_size"])
    answer_page = wallet.list_transactions
    answered = []

    def page_until_deadline(request):
        if len(answered) < case["pages_before_deadline"]:
            answered.append(request["offset"])
            return answer_page(request)
        # The next page is still in flight when the slice deadline passes.
        wallet.calls.append(dict(request))
        while time.monotonic() < request["_deadline"]:
            time.sleep(max(request["_deadline"] - time.monotonic(), 0.001))
        raise WalletError("TIMEOUT", "Wallet history scan deadline exceeded.")

    wallet.list_transactions = page_until_deadline
    paid = []
    for _ in range(case["max_passes"]):
        answered.clear()
        before = len(wallet.calls)
        reconciler(repository, clock, wallet, paid).reconcile()
        assert len(wallet.calls) - before <= case["pages_before_deadline"] + 1
        clock["now"] += 12
    assert repository.find_by_payment_hash(H1).status == "settled"
    assert len(paid) == 1


def test_first_page_cut_by_the_deadline_still_fails_the_pass(repository, clock, monkeypatch):
    from openreceive.server import reconcile

    monkeypatch.setattr(reconcile, "RECONCILE_SCAN_TIMEOUT_SECONDS", 0.3)
    now = clock["now"]
    saved = checkout("silent", H1, now, now + 600)
    saved["created_at_source"] = "wallet"
    repository.commit_attempt(PaymentInsert("silent", H1, saved))
    wallet = HistoryWallet([{"payment_hash": H1, "created_at": now, "settled_at": now + 1}])

    def never_answers(request):
        wallet.calls.append(dict(request))
        while time.monotonic() < request["_deadline"]:
            time.sleep(max(request["_deadline"] - time.monotonic(), 0.001))
        raise WalletError("TIMEOUT", "Wallet history scan deadline exceeded.")

    wallet.list_transactions = never_answers
    paid = []
    assert reconciler(repository, clock, wallet, paid).gated_reconcile()["reason"] == "scan_failed"
    assert len(wallet.calls) == 1
    assert repository.find_by_payment_hash(H1).status == "pending" and not paid


def host_clock_attempt_gets_its_own_window(case, repository, clock):
    host, timed = H1, H2
    host_at, timed_at, overlap = case["host_created_at"], case["wallet_created_at"], case["overlap"]
    # Legacy host-clock row: the saved checkout carries no created_at_source.
    repository.commit_attempt(
        PaymentInsert("host-clock", host, checkout("host-clock", host, host_at, host_at + 600))
    )
    saved = checkout("wallet-timed", timed, timed_at, timed_at + 600)
    saved["created_at_source"] = "wallet"
    repository.commit_attempt(PaymentInsert("wallet-timed", timed, saved))
    wallet = HistoryWallet(
        [{"payment_hash": timed, "created_at": timed_at, "settled_at": timed_at + 1}]
    )
    paid = []
    clock["now"] = timed_at + overlap
    for pass_index in range(case["max_passes"]):
        before = len(wallet.calls)
        reconciler(repository, clock, wallet, paid).reconcile()
        if pass_index == 0:
            first = wallet.calls[before]
            assert (first["from"], first.get("until")) == (timed_at - overlap, timed_at + overlap)
            assert repository.find_by_payment_hash(timed).status == "settled"
        clock["now"] += 12
    assert len(paid) == 1
    assert any(call["from"] == 0 and "until" not in call for call in wallet.calls)


def mixed_batches_cannot_skip_a_host_timed_attempt(case, repository, clock):
    start, count = case["created_at_start"], case["pending_count"]
    rows = []
    for i in range(count):
        h = f"{i + 1:064x}"
        saved = checkout(f"mixed-{i}", h, start + i, start + i + 100_000)
        saved["created_at_source"] = "wallet" if i % 2 == 0 else "host"
        repository.commit_attempt(PaymentInsert(f"mixed-{i}", h, saved))
        row = {"payment_hash": h, "created_at": start + i}
        if i == case["paid_index"]:
            row["settled_at"] = case["settled_at"]
        rows.append(row)
    wallet = HistoryWallet(rows, case["page_size"])

    def honors_window(request):
        wallet.calls.append(dict(request))
        visible = [
            row
            for row in rows
            if (request.get("unpaid") or "settled_at" in row)
            and row["created_at"] >= request["from"]
            and (request.get("until") is None or row["created_at"] <= request["until"])
        ]
        offset = request.get("offset", 0)
        return {"transactions": visible[offset : offset + case["page_size"]]}

    wallet.list_transactions = honors_window
    paid = []
    clock["now"] = start + count + 1000
    for _ in range(case["max_passes"]):
        # Recreate the reconciler on every slice; only DB state carries progress.
        before = len(wallet.calls)
        reconciler(repository, clock, wallet, paid).reconcile()
        assert len(wallet.calls) - before <= PROGRESS["max_pages"]
        clock["now"] += case["pass_seconds"]
    paid_hash = f"{case['paid_index'] + 1:064x}"
    assert repository.find_by_payment_hash(paid_hash).status == "settled"
    assert [event.payment_hash for event in paid] == [paid_hash]
    statuses = [repository.find_by_payment_hash(f"{i + 1:064x}").status for i in range(count)]
    assert statuses.count("pending") == count - 1
    claim = repository.claim_reconcile_gate(now=clock["now"], interval_seconds=2)
    assert claim is not None
    assert len(claim["scheduler"]["windows"]) <= PROGRESS["max_windows"]
    assert len(json.dumps(claim).encode()) <= PROGRESS["max_checkpoint_bytes"]


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
