"""The Python engine's runner for spec/test-vectors/attempt-state-machine.json:
one operation sequence replayed through the real SqlPaymentRepository and
Reconciler over SQLite, comparing the model's prediction after every step and
checking the state-machine invariants against the engine's own rows.

Run as a module (`python -m tests.vectors.attempt_state_machine_runner`) to
replay a file of sequences and print a JSON report; `npm run test:model` does.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from sqlalchemy import create_engine, event, text

from openreceive.server import Service
from openreceive.server.reconcile import Reconciler
from openreceive.storage import PaymentInsert
from openreceive.storage.repository import (
    AttemptConflict,
    PaymentSettlement,
    ReconciliationTransition,
    SettlementRecord,
    selected_for,
)
from openreceive.storage.sql import SqlPaymentRepository
from openreceive.testing import FakeWallet

STATUSES = {"pending", "settled", "expired", "failed", "attention"}
GRACE_SECONDS = 900
WALLET_SETTLED_STATES = {"settled_at", "settled_state", "settled_full"}
WALLET_TERMINAL_STATES = {"failed", "expired"}
CLOSED_STATUSES = {"expired", "failed", "attention"}


class CheckFailedError(Exception):
    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


def hash_of(identifier: int) -> str:
    return f"{identifier:064x}"


class ModelWallet(FakeWallet):
    """The vectors' fake wallet: rows are raw NIP-47 shapes, so the engine's
    own normalizer sees exactly what a real wallet would send."""

    def __init__(self, harness: StateMachineHarness) -> None:
        super().__init__()
        self.harness = harness

    def list_transactions(self, params: dict[str, Any] | None = None) -> Any:
        harness = self.harness
        request = dict(params or {})
        call_index = harness.wallet_calls
        harness.wallet_calls += 1
        mode = harness.wallet_mode
        if mode == "fail":
            raise RuntimeError("wallet unavailable (model)")
        if mode == "unrecognized_key":
            return {"rows": []}
        if mode == "unrecognized_type":
            return {"transactions": "nope"}
        if mode == "unusable_rows":
            return {"transactions": [1, 2]}
        if mode.startswith("fail_after_") and call_index >= int(mode.removeprefix("fail_after_")):
            raise RuntimeError("wallet unavailable (model)")
        low = request.get("from", 0)
        high = request.get("until")
        unpaid = bool(request.get("unpaid"))
        rows = [
            (identifier, row)
            for identifier, row in harness.wallet_rows.items()
            if row["created_at"] >= low
            and (high is None or row["created_at"] <= high)
            and (unpaid or row["state"] in WALLET_SETTLED_STATES)
        ]
        rows.sort(key=lambda item: (item[1]["created_at"], item[0]), reverse=True)
        offset = int(request.get("offset", 0))
        page = rows[offset : offset + int(request["limit"])]
        return {"transactions": [wire_row(identifier, row) for identifier, row in page]}


def wire_row(identifier: int, row: dict[str, Any]) -> dict[str, Any]:
    wire: dict[str, Any] = {
        "type": "incoming",
        "payment_hash": hash_of(identifier),
        "amount": 1000,
        "created_at": row["created_at"],
    }
    state = row["state"]
    if state == "settled_at":
        wire["settled_at"] = row["settled_at"]
    elif state == "settled_full":
        wire["state"] = "settled"
        wire["settled_at"] = row["settled_at"]
    elif state == "settled_state":
        wire["state"] = "settled"
    elif state != "stateless":
        wire["state"] = state
    return wire


def _fast_sqlite(connection: Any, _record: Any) -> None:
    connection.execute("PRAGMA synchronous = OFF")


class StateMachineHarness:
    def __init__(self, database_url: str) -> None:
        self.now = 0
        self.engine = create_engine(database_url)
        event.listen(self.engine, "connect", _fast_sqlite)
        self.repository = SqlPaymentRepository(self.engine, clock=lambda: self.now)
        self.repository.create_tables()
        self.ledger: list[list[object]] = []
        self.fail_fulfillment = False
        self.wallet_mode = "ok"
        self.wallet_calls = 0
        self.wallet_rows: dict[int, dict[str, Any]] = {}
        self.outcome: str | None = None
        self.reused_id: int | None = None
        self.last_reason: str | None = None
        self.rebuild()

    def rebuild(self) -> None:
        self.repository = SqlPaymentRepository(self.engine, clock=lambda: self.now)
        self.wallet = ModelWallet(self)
        self.service = Service(
            self.wallet, price_provider=False, swap_providers=[], clock=lambda: self.now
        )
        self.reconciler = Reconciler(
            service=self.service,
            repository=self.repository,
            on_paid=self.fulfill,
            clock=lambda: self.now,
        )

    def fulfill(self, settlement: PaymentSettlement) -> None:
        if self.fail_fulfillment:
            raise RuntimeError("host rollback (model)")
        self.ledger.append([settlement.reference, settlement.payment_hash])

    def set_wallet_row(
        self, identifier: int, kind: str, settled_at: int | None, created_at: int | None
    ) -> None:
        if kind == "absent":
            self.wallet_rows.pop(identifier, None)
            return
        existing = self.wallet_rows.get(identifier, {})
        self.wallet_rows[identifier] = {
            "created_at": existing.get("created_at", created_at),
            "state": kind,
            "settled_at": settled_at,
        }

    def checkout_for(self, step: dict[str, Any]) -> dict[str, Any]:
        identifier = step["id"]
        return {
            "reference": step["ref"],
            "payment_hash": hash_of(identifier),
            "bolt11": f"lnbc-{identifier}",
            "amount_msats": 1000,
            "created_at": step["created_at"],
            "created_at_source": "wallet",
            "expires_at": step["expires_at"],
            "fiat_quote": None,
        }

    def swap_data_for(self, step: dict[str, Any]) -> dict[str, Any] | None:
        if step["rail"] == "ln":
            return None
        return {
            "version": 1,
            "provider_order": {
                "provider": "model",
                "provider_order_id": f"order-{step['id']}",
                "provider_token": "model-token",
                "pay_in_asset": step["rail"],
                "expires_at": step["deposit_expires_at"],
            },
        }

    def commit(self, step: dict[str, Any]) -> None:
        self.repository.commit_attempt(
            PaymentInsert(
                step["ref"],
                hash_of(step["id"]),
                self.checkout_for(step),
                self.swap_data_for(step),
            )
        )

    def apply_step(self, step: dict[str, Any]) -> None:
        self.wallet_calls = 0
        self.wallet_mode = "ok"
        self.fail_fulfillment = step.get("fail_fulfillment") is True
        self.outcome = None
        self.reused_id = None
        self.last_reason = None
        kind = step["op"]
        if kind == "advance":
            return
        if kind == "restart":
            self.rebuild()
            return
        if kind == "wallet":
            self.set_wallet_row(
                step["id"], step["state"], step.get("settled_at"), step.get("created_at")
            )
            return
        if kind == "create":
            self.create(step)
            return
        if kind == "commit":
            try:
                self.commit(step)
                self.outcome = "inserted_or_idempotent"
            except AttemptConflict:
                self.outcome = "conflict"
            return
        if kind == "scan":
            self.wallet_mode = step["mode"]
            self.last_reason = self.reconciler.maybe_reconcile()["reason"]
            return
        if kind == "notify":
            self.notify(step)
            return
        if kind == "replay_settlement":
            try:
                self.repository.record_settlement(
                    SettlementRecord(hash_of(step["id"]), step["paid_at"], None), self.fulfill
                )
            except RuntimeError:
                if not self.fail_fulfillment:
                    raise
            return
        if kind == "stale_close":
            self.repository.record_reconciliation(
                ReconciliationTransition(
                    hash_of(step["id"]), step["status"], self.now, "stale_model"
                )
            )
            return
        raise AssertionError(f"unknown op {kind}")

    def create(self, step: dict[str, Any]) -> None:
        rail = step["rail"]
        action = "checkout.create" if rail == "ln" else "swap.create"
        try:
            selected = selected_for(
                self.repository.list_for_reference(step["ref"]),
                action=action,
                now=self.now,
                pay_in_asset=None if rail == "ln" else rail,
            )
        except AttemptConflict:
            self.outcome = "already_paid"
            return
        if selected is not None:
            self.outcome = "reused"
            self.reused_id = int(selected.payment_hash, 16)
            return
        self.commit(step)
        self.outcome = "inserted"

    def notify(self, step: dict[str, Any]) -> None:
        if step["kind"] != "sent":
            if step["finality"] == "settled_at":
                self.set_wallet_row(
                    step["id"], "settled_full", step["settled_at"], step["created_at"]
                )
            elif step["finality"] == "state":
                self.set_wallet_row(step["id"], "settled_state", None, step["created_at"])
        self.reconciler.handle_notification(self.notification_payload(step))

    def notification_payload(self, step: dict[str, Any]) -> dict[str, Any]:
        kind = "payment_sent" if step["kind"] == "sent" else "payment_received"
        finality = step["finality"]
        if finality == "absent":
            return {"notification_type": kind}
        payload: dict[str, Any] = {"payment_hash": hash_of(step["id"]), "amount": 1000}
        if finality == "settled_at":
            payload |= {"type": "incoming", "state": "settled", "settled_at": step["settled_at"]}
        elif finality == "state":
            payload |= {"type": "incoming", "state": "settled"}
        elif finality == "preimage":
            payload["preimage"] = "a" * 64
        return {"notification_type": kind, "notification": payload}

    def read_row(self, identifier: int) -> dict[str, Any] | None:
        record = self.repository.find_by_payment_hash(hash_of(identifier))
        if record is None:
            return None
        return {
            "status": record.status,
            "reason": record.status_reason,
            "paid_at": record.paid_at,
            "reference": record.reference,
            "expires_at": record.expires_at,
            "has_swap": record.is_swap,
        }

    def row_counts(self) -> tuple[int, int]:
        with self.engine.connect() as connection:
            row = connection.execute(
                text("SELECT COUNT(*), COUNT(DISTINCT payment_hash) FROM openreceive_payments")
            ).first()
        assert row is not None
        return int(row[0]), int(row[1])

    def dispose(self) -> None:
        self.engine.dispose()


def check_invariants(
    harness: StateMachineHarness,
    step: dict[str, Any],
    before: dict[int, dict[str, Any]],
    after: dict[int, dict[str, Any]],
    info: dict[int, dict[str, Any]],
) -> None:
    for identifier, row in after.items():
        if row["status"] not in STATUSES:
            raise CheckFailedError("invariant", f"row {identifier} has status {row['status']}")
        previous = before.get(identifier)
        if previous is not None and previous["status"] == "settled":
            unchanged = (row["status"], row["paid_at"], row["reason"]) == (
                "settled",
                previous["paid_at"],
                previous["reason"],
            )
            if not unchanged:
                raise CheckFailedError("invariant", f"settled row {identifier} overwritten: {row}")
        if (
            previous is not None
            and previous["status"] != "pending"
            and row["status"] != previous["status"]
        ):
            raise CheckFailedError(
                "invariant", f"closed row {identifier} changed status to {row['status']}"
            )
        if (
            previous is not None
            and previous["status"] == "pending"
            and row["status"] in CLOSED_STATUSES
        ):
            mode = step.get("mode", "")
            ran_scan = (
                step["op"] == "notify"
                or (step["op"] == "scan" and mode == "ok")
                or mode.startswith("fail_after_")
            )
            if not ran_scan:
                raise CheckFailedError(
                    "invariant", f"row {identifier} closed without a successful scan"
                )
            wallet_row = harness.wallet_rows.get(identifier)
            terminal = wallet_row is not None and wallet_row["state"] in WALLET_TERMINAL_STATES
            if not terminal and harness.now < info[identifier]["expires_at"] + GRACE_SECONDS:
                raise CheckFailedError(
                    "invariant", f"row {identifier} closed before expiry + grace"
                )
    fulfilled_counts: dict[str, int] = {}
    for reference, _ in harness.ledger:
        fulfilled_counts[str(reference)] = fulfilled_counts.get(str(reference), 0) + 1
    if any(count > 1 for count in fulfilled_counts.values()):
        raise CheckFailedError("invariant", f"a reference fulfilled twice: {harness.ledger}")
    settled_by_reference: dict[str, list[tuple[int, dict[str, Any]]]] = {}
    for identifier, row in after.items():
        if row["status"] == "settled":
            settled_by_reference.setdefault(row["reference"], []).append((identifier, row))
    for reference, rows in settled_by_reference.items():
        entries = [entry for entry in harness.ledger if entry[0] == reference]
        if len(entries) != 1:
            raise CheckFailedError(
                "invariant",
                f"reference {reference} has settled rows but {len(entries)} fulfillments",
            )
        first = [item for item in rows if item[1]["reason"] is None]
        if len(first) != 1 or hash_of(first[0][0]) != entries[0][1]:
            raise CheckFailedError(
                "invariant", f"fulfillment for {reference} went to the wrong row"
            )
        for identifier, row in rows:
            if row["reason"] not in (None, "duplicate_settlement"):
                raise CheckFailedError(
                    "invariant", f"settled row {identifier} has reason {row['reason']}"
                )
    live: dict[str, int] = {}
    for identifier, row in after.items():
        if row["status"] != "pending" or row["reason"] == "superseded":
            continue
        if row["expires_at"] <= harness.now:
            continue
        rail = info[identifier]["rail"] if row["has_swap"] else "ln"
        key = f"{row['reference']} {rail}"
        if key in live:
            raise CheckFailedError(
                "invariant", f"two live attempts on {key}: {live[key]} and {identifier}"
            )
        live[key] = identifier
    total, distinct = harness.row_counts()
    if total != distinct:
        raise CheckFailedError("invariant", "payment_hash is not unique")


def run_sequence(sequence: dict[str, Any], database_url: str) -> dict[str, Any]:
    harness = StateMachineHarness(database_url)
    expected: dict[int, list[Any]] = {}
    expected_ledger: list[list[Any]] = []
    info: dict[int, dict[str, Any]] = {}
    current: dict[int, dict[str, Any]] = {}
    try:
        for index, step in enumerate(sequence["steps"]):
            try:
                harness.now = step["t"]
                harness.apply_step(step)
                if "outcome" in step:
                    actual = harness.outcome
                    if (
                        step["op"] == "commit"
                        and actual == "inserted_or_idempotent"
                        and step["outcome"] in ("inserted", "idempotent")
                    ):
                        actual = step["outcome"]
                    if actual != step["outcome"]:
                        raise CheckFailedError(
                            "outcome", f"expected {step['outcome']}, got {actual}"
                        )
                    if step["outcome"] == "reused" and harness.reused_id != step["reused_id"]:
                        raise CheckFailedError(
                            "outcome", f"reused {harness.reused_id}, expected {step['reused_id']}"
                        )
                if "reason" in step and harness.last_reason != step["reason"]:
                    raise CheckFailedError(
                        "outcome", f"reason {harness.last_reason}, expected {step['reason']}"
                    )
                for key, row in step.get("rows", {}).items():
                    identifier = int(key)
                    if identifier not in expected:
                        info[identifier] = {
                            "expires_at": step.get("expires_at"),
                            "rail": step.get("rail"),
                        }
                    expected[identifier] = row
                expected_ledger.extend(step.get("fulfilled", []))
                after: dict[int, dict[str, Any]] = {}
                for identifier in expected:
                    row = harness.read_row(identifier)
                    if row is None:
                        raise CheckFailedError("state", f"row {identifier} missing from the engine")
                    after[identifier] = row
                check_invariants(harness, step, current, after, info)
                for identifier, wanted in expected.items():
                    got = after[identifier]
                    if [got["status"], got["reason"], got["paid_at"]] != wanted:
                        raise CheckFailedError(
                            "state", f"row {identifier}: engine {got}, model {wanted}"
                        )
                if harness.row_counts()[0] != len(expected):
                    raise CheckFailedError("state", "the engine holds rows the model does not")
                ledger = [[reference, int(str(paid), 16)] for reference, paid in harness.ledger]
                if ledger != expected_ledger:
                    raise CheckFailedError(
                        "state", f"fulfillment ledger {ledger}, model {expected_ledger}"
                    )
                current = after
            except CheckFailedError as error:
                return {
                    "name": sequence["name"],
                    "ok": False,
                    "step": index,
                    "kind": error.kind,
                    "message": str(error),
                }
            except Exception as error:  # a crash is a finding too: report the step
                return {
                    "name": sequence["name"],
                    "ok": False,
                    "step": index,
                    "kind": "error",
                    "message": f"{type(error).__name__}: {error}",
                }
        return {"name": sequence["name"], "ok": True}
    finally:
        harness.dispose()


def run_file(path: str) -> list[dict[str, Any]]:
    with open(path, encoding="utf-8") as handle:
        family = json.load(handle)
    results = []
    with tempfile.TemporaryDirectory() as directory:
        for index, sequence in enumerate(family["sequences"]):
            database = Path(directory) / f"sequence-{index}.sqlite3"
            results.append(run_sequence(sequence, f"sqlite:///{database}"))
    return results


if __name__ == "__main__":
    json.dump(run_file(sys.argv[1]), sys.stdout)
