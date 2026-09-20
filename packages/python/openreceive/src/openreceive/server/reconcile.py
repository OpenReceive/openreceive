"""Reconciliation over the engine-owned ledger: one bounded pass, the durably
gated opportunistic pass every payment route runs first, direct settlement
from an authenticated NWC-02 notification, and the worker's retry delay.
Twin of the Rails `reconcile.rb`; the JS reconcile-gate.ts / reconcile-loop.ts
are the secondary reference.
"""

from __future__ import annotations

import copy
import logging
import time
from collections.abc import Callable, Mapping
from typing import Any

from openreceive import settlement as settlement_rule
from openreceive.nwc.requests import normalize_transaction
from openreceive.payments import reconciliation
from openreceive.server.reconcile_scan import new_window, scan_slice
from openreceive.server.service import Service, sanitize_failure_message
from openreceive.storage.repository import (
    PaymentRepository,
    PaymentSettlement,
    ReconcilableAttempt,
    ReconciliationTransition,
    SettlementRecord,
)

log = logging.getLogger("openreceive")

# Floor for the durable reconcile-gate interval (seconds); stretched by invoice
# age (2s while any pending invoice is under 2 minutes old, 6s under 5 minutes,
# else 12s). The gate IS the NWC scan budget.
MIN_RECONCILE_INTERVAL_SECONDS = 2
# Wall-clock bound on an awaited request-path pass, enforced as a deadline the
# wallet scan checks between page fetches — never mid-request.
RECONCILE_SCAN_TIMEOUT_SECONDS = 9
# Wallet-history pages a request-path pass may walk.
RECONCILE_SCAN_MAX_PAGES = 50
# Cap on the notifications worker's resubscribe backoff, and the subscription
# lifetime past which the ramp resets to 1s.
NOTIFICATIONS_MAX_BACKOFF_SECONDS = 60

SettlementHook = Callable[[dict[str, Any]], None]


class Reconciler:
    """Binds a Service and a PaymentRepository to the settlement hook: every
    settlement OpenReceive discovers — a wallet scan or a notification — goes
    through `repository.record_settlement` (write-once) and runs the host's
    `on_paid` for the reference's first settled attempt only."""

    def __init__(
        self,
        *,
        service: Service,
        repository: PaymentRepository,
        on_paid: Callable[[PaymentSettlement], None],
        after_paid: Callable[[PaymentSettlement], None] | None = None,
        opportunistic_reconcile: bool | Mapping[str, Any] = True,
        clock: Callable[[], int] | None = None,
    ) -> None:
        if (
            after_paid is not None
            and getattr(repository, "supports_after_commit", False) is not True
        ):
            raise ValueError(
                "after_paid requires a repository implementing the actual after_commit contract (supports_after_commit=True)."
            )
        self.service = service
        self.repository = repository
        self._on_paid = on_paid
        self._after_paid = after_paid
        self.opportunistic_reconcile = opportunistic_reconcile
        self._clock: Callable[[], int] = clock or (lambda: int(time.time()))

    # ---------------------------------------------------------- settlement

    def settle(self, event: Mapping[str, Any]) -> bool:
        """The settlement hook shared by payments/check, the reconcile pass and
        notifications: {payment_hash, paid_at, details} → write-once + on_paid
        (inside the transaction) + after_paid (after COMMIT). Returns whether
        this call won the reference's first settlement."""
        record = SettlementRecord(
            payment_hash=str(event["payment_hash"]).lower(),
            paid_at=int(event["paid_at"]),
            details=event.get("details"),
        )

        def after_commit(payment: PaymentSettlement) -> None:
            if self._after_paid is None:
                return
            try:
                self._after_paid(payment)
            except Exception as error:
                log.warning(
                    "[openreceive] after_paid failed after commit: %s",
                    sanitize_failure_message(error),
                )

        return self.repository.record_settlement(
            record,
            self._on_paid,
            after_commit=after_commit if self._after_paid is not None else None,
        )

    # ---------------------------------------------------------------- pass

    def maybe_reconcile(self, *, now: int | None = None) -> dict[str, Any]:
        """Opportunistic settlement discovery, piggybacked on any OpenReceive
        call: skip without a wallet call when nothing is pending, try the
        durable gate ("gate_busy" means another worker just scanned), otherwise
        AWAIT one bounded pass. Never raises: a failed scan warns and returns
        "scan_failed" — the caller's own request must not fail because a
        settlement sweep did, and claimed_at stays so a broken wallet cannot
        stampede. Returns {"reason": "ran", "checks": [...]} or {"reason":
        "disabled" | "no_pending" | "gate_busy" | "scan_failed"}."""
        if self.opportunistic_reconcile is False:
            return {"reason": "disabled"}
        return self.gated_reconcile(now=now)

    def reconcile(
        self, *, overlap_seconds: int = 60, now: int | None = None
    ) -> list[dict[str, Any]]:
        checks: list[dict[str, Any]] = self.gated_reconcile(
            now=now, overlap_seconds=overlap_seconds
        ).get("checks", [])
        return checks

    def gated_reconcile(
        self, *, now: int | None = None, overlap_seconds: int = 60
    ) -> dict[str, Any]:
        if not all(
            callable(getattr(self.repository, name, None))
            for name in ("claim_reconcile_gate", "checkpoint_reconcile_gate")
        ):
            raise ValueError(
                "Reconciliation workers require durable claim_reconcile_gate and checkpoint_reconcile_gate repository operations."
            )
        claim = None
        try:
            attempts = self.repository.list_reconcilable_attempts()
            if not attempts:
                return {"reason": "no_pending"}
            observed_at = int(now if now is not None else self._clock())
            interval = reconcile_gate_interval_seconds(
                attempts, observed_at, self.opportunistic_reconcile
            )
            claim = self.repository.claim_reconcile_gate(now=observed_at, interval_seconds=interval)
            if claim is None:
                return {"reason": "gate_busy"}
            scheduler = copy.deepcopy(claim["scheduler"])
            windows = scheduler["windows"]
            if len(windows) < 2:
                candidates = self.repository.list_reconcilable_attempts(after=scheduler["cursor"])
                if not candidates:
                    scheduler["cursor"] = None
                    candidates = self.repository.list_reconcilable_attempts()
                if candidates:
                    last = candidates[-1]
                    scheduler["cursor"] = {
                        "created_at": last.created_at,
                        "payment_hash": last.payment_hash,
                    }
                    queued = {a["payment_hash"] for w in windows for a in w["attempts"]}
                    cohort = [a.as_dict() for a in candidates if a.payment_hash not in queued]
                    if cohort:
                        windows.append(new_window(cohort, observed_at, overlap_seconds))
            # Rotate durably before I/O: one failing cohort cannot pin the queue.
            window = windows.pop(0) if windows else None
            if window is not None:
                windows.append(window)
            # Claim winner alone advances fair selection, before any wallet I/O.
            if not self.repository.checkpoint_reconcile_gate(
                claim, scheduler, now=self._clock() if now is None else observed_at
            ):
                return {"reason": "gate_busy"}
            if not windows:
                self.repository.checkpoint_reconcile_gate(
                    claim, scheduler, now=observed_at, release=True
                )
                return {"reason": "no_pending"}
            assert window is not None
            by_hash = {a["payment_hash"]: ReconcilableAttempt(**a) for a in window["attempts"]}
            delivered: dict[str, bool] = {}
            before_scan = copy.deepcopy(scheduler)

            def deliver_finality(checked: dict[str, Any]) -> None:
                hash_value = str(checked["payment_hash"])
                current_time = self._clock() if now is None else observed_at
                if not self.repository.checkpoint_reconcile_gate(
                    claim, before_scan, now=current_time
                ):
                    delivered[hash_value] = False
                    return
                if checked.get("status") == "settled" and checked.get("paid_at"):
                    delivered[hash_value] = self._settle_attempt(checked)
                else:
                    self._record_transition(by_hash[hash_value], checked, observed_at)
                    delivered[hash_value] = True

            checks, complete, stalled = scan_slice(
                self.service,
                window,
                max_pages=RECONCILE_SCAN_MAX_PAGES,
                deadline=time.monotonic() + RECONCILE_SCAN_TIMEOUT_SECONDS,
                on_finality=deliver_finality,
            )
            lease_owned = self.repository.checkpoint_reconcile_gate(
                claim, before_scan, now=self._clock() if now is None else observed_at
            )
            committed = []
            for checked in checks:
                attempt = by_hash[checked["payment_hash"]]
                if checked["payment_hash"] in delivered:
                    if not delivered[checked["payment_hash"]]:
                        continue
                elif checked.get("status") == "settled" and checked.get("paid_at"):
                    continue  # Result arrived after this pass lost its deadline/lease.
                else:
                    if not lease_owned:
                        continue
                    self._record_transition(
                        attempt, checked, int(checked.get("_coverage_started_at", observed_at))
                    )
                committed.append(
                    {key: value for key, value in checked.items() if not key.startswith("_")}
                )
            windows.remove(window)
            if not complete and not stalled:
                # Distinct creation buckets can reduce future sweeps; same-second
                # history keeps its physical continuation without skipping timestamps.
                times = sorted({a["created_at"] for a in window["attempts"]})
                if (
                    len(windows) == 0
                    and len(times) > 1
                    and all(a.get("created_at_source") == "wallet" for a in window["attempts"])
                ):
                    middle = times[len(times) // 2]
                    for half in (
                        [a for a in window["attempts"] if a["created_at"] < middle],
                        [a for a in window["attempts"] if a["created_at"] >= middle],
                    ):
                        windows.append(new_window(half, observed_at, overlap_seconds))
                else:
                    windows.append(window)
            checkpoint_now = self._clock() if now is None else observed_at
            self.repository.checkpoint_reconcile_gate(
                claim, scheduler, now=checkpoint_now, release=True
            )
            self._log_pass(list(by_hash.values()), committed, window)
            return {"reason": "ran", "checks": committed}
        except Exception as error:
            log.warning(
                "[openreceive] reconciliation failed (will retry): %s",
                sanitize_failure_message(error),
            )
            return {"reason": "scan_failed"}

    def attempt_status(self, payment_hash: str) -> dict[str, Any] | None:
        """The persisted {status, paid_at?} for payments/check's row path."""
        record = self.repository.find_by_payment_hash(payment_hash.lower())
        if record is None:
            return None
        status: dict[str, Any] = {"status": record.status}
        if record.paid_at is not None:
            status["paid_at"] = record.paid_at
        return status

    # ------------------------------------------------------- notifications

    def handle_notification(
        self, notification: Mapping[str, Any], *, overlap_seconds: int = 60
    ) -> str:
        """One NWC-02 payload: a `payment_received` that satisfies the settlement
        rule and matches a pending attempt settles directly (no wallet scan for
        that invoice); anything less wakes one bounded pass. Returns
        "ignored" | "settled" | "scanned"."""
        if not _is_payment_received(notification):
            return "ignored"
        if self.settle_from_notification(notification):
            return "settled"
        self.reconcile(overlap_seconds=overlap_seconds)
        return "scanned"

    def settle_from_notification(self, notification: Mapping[str, Any]) -> bool:
        payload = notification.get("notification")
        if not isinstance(payload, Mapping):
            return False
        try:
            transaction = normalize_transaction(payload)
            if settlement_rule.status(transaction) != "settled":
                return False
            payment_hash = str(transaction.get("payment_hash") or "").lower()
            if not payment_hash or self.repository.find_pending_attempt(payment_hash) is None:
                return False
            observed_at = self._clock()
            self.settle(
                {
                    "payment_hash": payment_hash,
                    "paid_at": transaction.get("settled_at") or observed_at,
                    "details": {
                        "transaction": transaction,
                        "observed_at": observed_at,
                        "paid_at_source": "settled_at"
                        if transaction.get("settled_at")
                        else "observed_at",
                    },
                }
            )
            status = self.attempt_status(payment_hash)
            return status is not None and status["status"] == "settled"
        except Exception as error:
            # A direct-settlement failure falls back to the scan-based safety net.
            log.warning(
                "[openreceive] direct settlement from notification failed: %s",
                sanitize_failure_message(error),
            )
            return False

    # ------------------------------------------------------------ internals

    def _settle_attempt(self, checked: dict[str, Any]) -> bool:
        """One failing settlement must not abort the rest of the pass."""
        try:
            self.settle(
                {
                    "payment_hash": checked["payment_hash"],
                    "paid_at": checked["paid_at"],
                    "details": checked.get("details"),
                }
            )
        except Exception as error:
            log.warning(
                "[openreceive] settlement for %s failed (will retry next pass): %s",
                checked["payment_hash"],
                sanitize_failure_message(error),
            )

            return False
        status = self.attempt_status(str(checked["payment_hash"]))
        return status is not None and status.get("status") == "settled"

    def _record_transition(
        self, attempt: ReconcilableAttempt, checked: dict[str, Any], observed_at: int
    ) -> None:
        details = checked.get("details") or {}
        transaction = details.get("transaction") or {} if isinstance(details, Mapping) else {}
        transition = reconciliation.transition(
            expires_at=attempt.expires_at,
            status=str(checked["status"]),
            observed_at=observed_at,
            # The normalized row carries "transaction_state" only.
            transaction_state=transaction.get("transaction_state")
            if isinstance(transaction, Mapping)
            else None,
        )
        if transition is None:
            return
        self.repository.record_reconciliation(
            ReconciliationTransition(
                payment_hash=str(checked["payment_hash"]),
                status=str(transition["status"]),
                observed_at=observed_at,
                reason=str(transition["reason"]),
            )
        )

    @staticmethod
    def _log_pass(
        attempts: list[ReconcilableAttempt],
        results: list[dict[str, Any]],
        window: dict[str, Any],
    ) -> None:
        """One short info line per pass: passes are durably gated, so operators
        can watch settlement discovery without raising the log level."""
        try:
            counts: dict[str, int] = {}
            for checked in results:
                counts[str(checked.get("status"))] = counts.get(str(checked.get("status")), 0) + 1
            decided = [
                f"{counts[status]} {status.replace('_', ' ')}"
                for status in ("settled", "pending", "not_found")
                if counts.get(status)
            ]
            scanned = "" if len(results) == len(attempts) else f" of {len(attempts)} attempts"
            log.info(
                "[openreceive] payment.reconcile.completed: %s%s attempt_count=%d window=%s..%s",
                ", ".join(decided) or "0 decided",
                scanned,
                len(attempts),
                window["from"],
                window["until"] if window["until"] is not None else "unbounded",
            )
        except Exception:
            pass


def reconcile_gate_interval_seconds(
    attempts: list[ReconcilableAttempt], now: int, setting: bool | Mapping[str, Any]
) -> int:
    """The configured floor stretched by invoice age: 2s while any pending
    invoice is under 2 minutes old, 6s under 5 minutes, else 12s."""
    floor = MIN_RECONCILE_INTERVAL_SECONDS
    if isinstance(setting, Mapping) and setting.get("min_interval_seconds") is not None:
        floor = max(int(setting["min_interval_seconds"]), floor)
    if not attempts:
        return floor
    stretch = min(_interval_for_age(max(now - attempt.created_at, 0)) for attempt in attempts)
    return max(floor, stretch)


def _interval_for_age(elapsed: int) -> int:
    if elapsed < 120:
        return 2
    if elapsed < 300:
        return 6
    return 12


def notifications_retry_delay(previous_delay: int | None, subscribed_seconds: float) -> int:
    """Doubles per consecutive failure up to the cap; a subscription that stayed
    up at least that long was healthy, so the next drop restarts the ramp."""
    if previous_delay is None or subscribed_seconds >= NOTIFICATIONS_MAX_BACKOFF_SECONDS:
        return 1
    return min(previous_delay * 2, NOTIFICATIONS_MAX_BACKOFF_SECONDS)


def _is_payment_received(notification: Mapping[str, Any]) -> bool:
    kind = notification.get("notification_type", notification.get("type"))
    return str(kind) == "payment_received"
