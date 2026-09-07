"""The payment-attempt repository contract: the row shape OpenReceive needs,
the operations a repository must provide, and the pure decisions the library
makes about rows — is an unpaid attempt still reusable, does a live row block
an incoming attempt, which attempt does a route act on. These decisions ARE
the settlement state machine; the Rails `OpenReceivePayment` model and the JS
`payment-repository.ts` implement the same rules and the shared vectors pin
them. Change them only with the vectors.

`openreceive.storage.sql.SqlPaymentRepository` is the library repository for
SQLAlchemy hosts; `openreceive.django` ships the ORM-backed one. Implementing
the protocol directly is the documented escape hatch, never the quickstart.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

from openreceive.values import LOWER_HEX_64_PATTERN, compact, to_int

ATTEMPT_STATUSES = ("pending", "settled", "expired", "failed", "attention")
# Seconds of remaining life required before a live attempt is reused instead of reminted.
ATTEMPT_REUSE_BUFFER_SECONDS = 60
# Generation of the openreceive_payments / openreceive_meta schema this library
# writes and reads; the repository refuses a strictly newer generation.
PAYMENTS_SCHEMA_VERSION = 1
# Oldest-first page size for one reconciliation pass: a backlog drains over
# several passes instead of widening one wallet scan window without bound.
RECONCILE_BATCH_SIZE = 200
# The one durable reconcile-gate row every worker shares.
RECONCILE_GATE_KEY = "transaction_scan_gate"
SCHEMA_VERSION_KEY = "schema_version"
# Tolerance when reading a timestamp another worker wrote: beyond it a claim
# stamped in the future is a backwards clock step, not a fresh claim.
META_CLOCK_SKEW_SECONDS = 60
# Namespacing seed for the postgres per-reference advisory lock, shared with
# the JS repository and the Rails model so mixed deployments serialize alike.
ADVISORY_LOCK_SEED = 8_210_223


class AttemptConflict(Exception):
    """A meaningful repository refusal (already paid, a live attempt on the same
    rail); the handler maps it to 409 CONFLICT with the message verbatim."""


class SchemaError(RuntimeError):
    """The tables are not migrated, or were written by a newer library."""


class LockTimeout(RuntimeError):
    pass


@dataclass(frozen=True)
class PaymentRecord:
    reference: str
    payment_hash: str
    status: str
    status_reason: str | None
    paid_at: int | None
    expires_at: int
    created_at: int
    checkout: dict[str, Any]
    # Server-only provider recovery data: excluded from repr and public dicts.
    swap_data: dict[str, Any] | None = field(default=None, repr=False)

    def public_dict(self) -> dict[str, Any]:
        return {
            "reference": self.reference,
            "payment_hash": self.payment_hash,
            "status": self.status,
            "status_reason": self.status_reason,
            "paid_at": self.paid_at,
            "expires_at": self.expires_at,
            "created_at": self.created_at,
            "checkout": dict(self.checkout),
        }

    @property
    def is_swap(self) -> bool:
        return bool(self.swap_data)


@dataclass(frozen=True)
class PaymentInsert:
    """What `commit_attempt` receives: the minted checkout snapshot plus the
    server-only swap recovery payload; timestamps derive from them."""

    reference: str
    payment_hash: str
    checkout: dict[str, Any]
    swap_data: dict[str, Any] | None = field(default=None, repr=False)
    client_ip: str | None = None

    @property
    def expires_at(self) -> int:
        return attempt_expires_at(self.checkout, self.swap_data)

    @property
    def created_at(self) -> int:
        return attempt_created_at(self.checkout)


@dataclass(frozen=True)
class ReconcilableAttempt:
    payment_hash: str
    created_at: int
    expires_at: int

    def as_dict(self) -> dict[str, int | str]:
        return {
            "payment_hash": self.payment_hash,
            "created_at": self.created_at,
            "expires_at": self.expires_at,
        }


@dataclass(frozen=True)
class ReconciliationTransition:
    payment_hash: str
    status: str  # expired | failed | attention
    observed_at: int
    reason: str


@dataclass(frozen=True)
class SettlementRecord:
    payment_hash: str
    paid_at: int
    details: dict[str, Any] | None = None


@dataclass
class PaymentSettlement:
    """Handed to the host's `on_paid` INSIDE the settlement transaction, for the
    reference's first settled attempt only. `connection` is the transaction's
    SQLAlchemy Connection in SQL mode (the JS `query` twin) and None under an
    ORM whose transaction is ambient (Django's `transaction.atomic()`)."""

    reference: str
    payment_hash: str
    paid_at: int
    details: dict[str, Any] | None = None
    connection: Any = None


FulfillHook = Callable[[PaymentSettlement], None]


class PaymentRepository(Protocol):
    def list_for_reference(self, reference: str) -> list[PaymentRecord]:
        """Every attempt for one reference, newest first (created_at desc, payment_hash desc)."""

    def list_reconcilable_attempts(self) -> list[ReconcilableAttempt]:
        """The oldest `pending` attempts, at most RECONCILE_BATCH_SIZE."""

    def find_pending_attempt(self, payment_hash: str) -> ReconcilableAttempt | None:
        """The pending attempt for one hash, or None when unknown or terminal."""

    def commit_attempt(self, insert: PaymentInsert) -> PaymentRecord:
        """Serialize per reference, refuse a settled reference or a reusable live
        attempt on the same rail (AttemptConflict), supersede a near-expiry
        same-rail attempt, and commit before returning. Idempotent for a
        repeated payment_hash."""

    def record_reconciliation(self, transition: ReconciliationTransition) -> None:
        """Apply a terminal transition only while the row is still pending."""

    def record_settlement(
        self, settlement: SettlementRecord, fulfill: FulfillHook | None = None
    ) -> bool:
        """Write-once settlement: True only for the call that won the reference's
        first-settlement claim (and ran `fulfill` inside the transaction). A
        later sibling settlement is recorded with reason duplicate_settlement."""

    def count_attempts_from_ip(self, client_ip: str, since_unix_seconds: int) -> int:
        """Attempts stamped for this IP at or after `since` — on inserted_at."""

    def claim_reconcile_gate(self, *, now: int, interval_seconds: int) -> bool:
        """Durable CAS gate shared by every worker on the host database."""


# ---------------------------------------------------------------- decisions


def is_reusable(expires_at: int, now: int) -> bool:
    return expires_at - now > ATTEMPT_REUSE_BUFFER_SECONDS


def is_live(record: PaymentRecord, now: int) -> bool:
    """A superseded row stays pending so the wallet scan keeps covering it, but
    it is no longer offered to a payer — so it neither blocks a new attempt nor
    is superseded again."""
    return (
        record.status == "pending"
        and record.expires_at > now
        and record.status_reason != "superseded"
    )


def swap_pay_in_asset(swap_data: dict[str, Any] | None) -> str | None:
    if not swap_data:
        return None
    order = swap_data.get("provider_order")
    if isinstance(order, dict):
        value = order.get("pay_in_asset")
        return str(value) if value is not None else None
    return None


def same_rail_and_asset(left: dict[str, Any] | None, right: dict[str, Any] | None) -> bool:
    left_present, right_present = bool(left), bool(right)
    if left_present != right_present:
        return False
    if not left_present:
        return True
    return swap_pay_in_asset(left) == swap_pay_in_asset(right)


def live_attempt_commit_decision(
    live: PaymentRecord, incoming_swap_data: dict[str, Any] | None, now: int
) -> str:
    """ "ignore" | "conflict" | "supersede" for one existing live row vs an incoming insert."""
    if not same_rail_and_asset(live.swap_data, incoming_swap_data):
        return "ignore"
    return "conflict" if is_reusable(live.expires_at, now) else "supersede"


def attempt_expires_at(checkout: dict[str, Any], swap_data: dict[str, Any] | None) -> int:
    provider_expiry = None
    if swap_data and isinstance(swap_data.get("provider_order"), dict):
        provider_expiry = swap_data["provider_order"].get("expires_at")
    value = provider_expiry if provider_expiry is not None else checkout.get("expires_at")
    return to_int(value)


def attempt_created_at(checkout: dict[str, Any]) -> int:
    return to_int(checkout.get("created_at"))


def normalize_payment_hash(value: object) -> str:
    normalized = str(value or "").strip().lower()
    if LOWER_HEX_64_PATTERN.match(normalized) is None:
        raise ValueError("invalid payment_hash")
    return normalized


def matches_create_action(record: PaymentRecord, action: str, pay_in_asset: str | None) -> bool:
    if action == "checkout.create":
        return not record.is_swap
    if action != "swap.create" or not record.is_swap:
        return False
    if not pay_in_asset:
        return True
    return swap_pay_in_asset(record.swap_data) == pay_in_asset


def selected_for(
    records: list[PaymentRecord],
    *,
    action: str,
    now: int,
    payment_hash: str | None = None,
    pay_in_asset: str | None = None,
) -> PaymentRecord | None:
    """Which attempt a route acts on (the Rails `OpenReceivePayment.selected_for`
    rule over an already-loaded, newest-first list). A create action reuses a
    live same-rail attempt with enough life left, refuses a paid reference, and
    refuses a reference with several live attempts for one method; swap reads
    and refunds take the newest swap attempt; other reads the newest attempt."""
    if payment_hash and payment_hash.strip():
        wanted = payment_hash.strip().lower()
        return next((record for record in records if record.payment_hash == wanted), None)
    if action in ("checkout.create", "swap.create"):
        if any(record.status == "settled" for record in records):
            raise AttemptConflict("This reference is already paid.")
        matching = [
            record
            for record in records
            if is_live(record, now) and matches_create_action(record, action, pay_in_asset)
        ]
        if len(matching) > 1:
            raise AttemptConflict(
                "This reference has multiple unpaid checkouts in progress for this payment method; "
                "wait for them to expire before creating another."
            )
        if not matching or not is_reusable(matching[0].expires_at, now):
            return None
        return matching[0]
    scope = (
        [record for record in records if record.is_swap]
        if action in ("swap.read", "swap.refund")
        else records
    )
    return scope[0] if scope else None


def is_fresh_timestamp(now: int, timestamp: int, window_seconds: int) -> bool:
    """True when `timestamp` is inside `window_seconds` of `now`, allowing for
    skew: a stamp far in the future is a clock that stepped backwards, not a
    fresh claim, so it reads as stale."""
    age = now - timestamp
    if age < -META_CLOCK_SKEW_SECONDS:
        return False
    return age < window_seconds


def public_record_dicts(records: list[PaymentRecord]) -> list[dict[str, Any]]:
    return [compact(record.public_dict()) for record in records]
