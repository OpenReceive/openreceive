"""`OpenReceiveApp`: the framework-free, storage-aware entry point every
adapter mounts. It wires a `Service`, a `Host` and a `PaymentRepository` into
the `RequestHandler` (engine-owned resolve/commit/settle hooks), runs the
durably gated opportunistic reconcile before every payment route, and serves
payments/check from that pass. Twin of the Rails `Configuration` +
`ApplicationController` pair and the JS `createHost` + handler.

    app = OpenReceiveApp(service=service, host=host, repository=repository)
    response = app.handle(HttpRequest(method=..., path=..., headers=..., body=...))
    status, body, headers = response
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable, Mapping
from typing import Any

from openreceive.server.errors import (
    ConfigurationError,
    ConflictError,
    HostPersistenceError,
    NotFoundError,
    ServiceError,
)
from openreceive.server.handler import HookContext, HttpRequest, HttpResponse, RequestHandler
from openreceive.server.hosts import Host, price_description, price_only
from openreceive.server.rate_limit import built_in_rate_limit
from openreceive.server.reconcile import RECONCILE_SCAN_TIMEOUT_SECONDS, Reconciler
from openreceive.server.service import Service, sanitize_failure_message
from openreceive.storage.repository import (
    AttemptConflict,
    PaymentInsert,
    PaymentRecord,
    PaymentRepository,
    ReconcilableAttempt,
    selected_for,
    settlement_expires_at,
)

log = logging.getLogger("openreceive")

PRICING_ACTIONS = ("checkout.prepare", "swap.quote", "checkout.create", "swap.create")
QUOTE_ACTIONS = ("checkout.prepare", "swap.quote")
# How far back an earlier attempt's invoice may have expired and still be
# checked before a new attempt is minted. A payment lands before its invoice
# expires; this only covers the scan that has not caught up with it yet.
EARLIER_ATTEMPT_LOOKBACK_SECONDS = 10 * 60


class OpenReceiveApp:
    def __init__(
        self,
        *,
        service: Service,
        host: Host,
        repository: PaymentRepository,
        prefix: str = "/openreceive",
        rate_limiting: bool | Mapping[str, Any] = False,
        rate_limit: Callable[[HookContext], bool] | None = None,
        client_ip: Callable[[Any], str | None] | None = None,
        opportunistic_reconcile: bool | Mapping[str, Any] = True,
        clock: Callable[[], int] | None = None,
        report_unexpected_error: Callable[[BaseException, str], None] | None = None,
    ) -> None:
        if any(
            getattr(host, name, None) is None for name in ("authorize", "amount_for", "on_paid")
        ):
            raise ConfigurationError(
                "Host requires amount_for, authorize and on_paid. https://openreceive.org/guides/api-reference.md"
            )
        if rate_limiting and rate_limit is not None:
            raise ConfigurationError(
                "Set either rate_limiting (the built-in per-IP limiter) or a custom rate_limit hook, not both. "
                "https://openreceive.org/guides/rate-limiting.md"
            )
        if opportunistic_reconcile is not False and not all(
            callable(getattr(repository, name, None))
            for name in ("claim_reconcile_gate", "checkpoint_reconcile_gate")
        ):
            # The default settlement path never degrades silently.
            raise ConfigurationError(
                "opportunistic_reconcile (on by default) needs repository.claim_reconcile_gate and checkpoint_reconcile_gate — a durable CAS gate "
                "shared by every worker. Implement it, or pass opportunistic_reconcile=False and run your own "
                "settlement worker. https://openreceive.org/guides/storage.md"
            )
        self.service = service
        self.host = host
        self.repository = repository
        self.prefix = prefix.rstrip("/")
        self._clock: Callable[[], int] = clock or (lambda: int(time.time()))
        extract_ip: Callable[[Any], str | None] = client_ip or (
            lambda request: getattr(request, "remote_addr", None)
        )
        self._client_ip = extract_ip
        self.reconciler = Reconciler(
            service=service,
            repository=repository,
            on_paid=host.on_paid,
            after_paid=host.after_paid,
            opportunistic_reconcile=opportunistic_reconcile,
            clock=self._clock,
        )
        host.warn_about_placeholders()
        self.handler = RequestHandler(
            service=service,
            authorize=host.authorize,
            resolve_checkout=self._resolve_checkout,
            on_checkout_created=self._on_checkout_created,
            on_paid=self._settlement_hook,
            rate_limit=built_in_rate_limit(
                repository, rate_limiting, client_ip=extract_ip, clock=self._clock
            )
            if rate_limiting
            else rate_limit,
            client_ip=extract_ip,
            prefix=self.prefix,
            report_unexpected_error=report_unexpected_error,
            before_mint=self._assert_earlier_attempts_unpaid,
        )

    # ------------------------------------------------------------- requests

    def handle(self, request: HttpRequest) -> HttpResponse:
        """One wire request → (status, body, headers). Any PAYMENT route is a
        settlement trigger: after the route matched and before its own work,
        one durably gated reconcile pass runs (never raising); payments/check
        consumes it — exactly one gate claim per request. GET /rates is exempt."""
        kind = RequestHandler.route_kind(request, self.prefix)
        if kind is None or kind == "rates":
            return self.handler.dispatch(request)
        # The body cap runs FIRST: an anonymous oversized POST is refused without
        # a database read, a gate claim or a wallet scan.
        content_length = request.content_length
        declared = request.header("content-length")
        if (content_length is not None and content_length > 64 * 1024) or (
            declared is not None and declared.strip().isdigit() and int(declared) > 64 * 1024
        ):
            return self.handler.dispatch(request)
        reconcile_pass = self.reconciler.maybe_reconcile()
        return self.handler.dispatch(
            request, reconcile_pass=reconcile_pass, attempt_status=self.reconciler.attempt_status
        )

    # --------------------------------------------------- engine-owned hooks

    def _resolve_checkout(
        self,
        *,
        action: str,
        request: Any,
        reference: str,
        body: Mapping[str, Any],
        pay_in_asset: str | None = None,
    ) -> dict[str, Any]:
        """The host is asked only where a price is minted or quoted. Status
        polls and refund recovery for committed attempts are answered from the
        engine's own rows and never wait for the host's price hook."""
        records = [] if action == "swap.quote" else self.repository.list_for_reference(reference)
        # Before the host is asked for a price: a host may well answer None for
        # an order it already knows is paid, and "unknown order" is the wrong
        # thing to tell the payer who paid it.
        paid = next((record for record in records if record.status == "settled"), None)
        if paid is not None and action == "checkout.prepare":
            return {**_paid_attempt(paid), "paid": True}
        if paid is not None and action in ("checkout.create", "swap.create"):
            raise ConflictError("This reference is already paid.")
        pricing = action in PRICING_ACTIONS
        price = self.host.amount_for(reference) if pricing else None
        if pricing and price is None:
            raise NotFoundError("Unknown reference.")
        resolved: dict[str, Any] = {}
        if pricing:
            resolved["amount"] = price_only(price)
            description = price_description(price)
            if description:
                resolved["description"] = description
        if action == "checkout.prepare":
            pending = _newest_pending(records)
            if pending is not None:
                resolved["pending_payment_hash"] = pending.payment_hash
        if action in QUOTE_ACTIONS:
            return resolved
        requested_hash = body.get("payment_hash") if isinstance(body, Mapping) else None
        try:
            payment = selected_for(
                records,
                action=action,
                now=self._clock(),
                payment_hash=str(requested_hash) if requested_hash else None,
                pay_in_asset=pay_in_asset,
            )
        except AttemptConflict as error:
            raise ConflictError(str(error))
        if requested_hash and str(requested_hash).strip() and payment is None:
            raise NotFoundError("Payment attempt not found for this reference.")
        if payment is not None:
            resolved["payment_hash"] = payment.payment_hash
            resolved["checkout"] = dict(payment.checkout)
            if payment.swap_data is not None:
                resolved["swap_data"] = dict(payment.swap_data)
        if paid is not None:
            # payments/check answers it as `paid` on every attempt of the order.
            resolved["paid_attempt"] = _paid_attempt(paid)
        return resolved

    def _on_checkout_created(
        self,
        *,
        reference: str,
        payment_hash: str,
        checkout: Mapping[str, Any],
        swap_data: Mapping[str, Any] | None = None,
        client_ip: str | None = None,
    ) -> None:
        try:
            self.repository.commit_attempt(
                PaymentInsert(
                    reference=reference,
                    payment_hash=payment_hash,
                    checkout=dict(checkout),
                    swap_data=None if swap_data is None else dict(swap_data),
                    client_ip=client_ip,
                )
            )
        except AttemptConflict as error:
            # A live same-method row is a 409 CONFLICT, never a retryable 503.
            raise ConflictError(str(error))
        except Exception as error:
            raise HostPersistenceError() from error

    def _assert_earlier_attempts_unpaid(
        self, *, reference: str, reconcile_pass: Mapping[str, Any] | None
    ) -> None:
        """Before a new attempt is minted for an order that already has unpaid
        ones, those are checked against the wallet, and a paid one refuses the
        mint as "already paid".

        Without it, an order paid moments ago could be handed a swap deposit
        address: the payer pays the invoice, the page reloads before the next
        wallet scan (the gate waits 3 to 12 s between scans), the payer picks a
        coin, and a provider order opens for an order already paid. A payer who
        sends that coin pays twice. The gated pass at the top of every request
        is skipped while the gate is closed, so it cannot be relied on here.

        Only a request that mints pays for this: one bounded wallet history walk
        over the reference's own pending attempts whose invoice expired at most
        EARLIER_ATTEMPT_LOOKBACK_SECONDS ago and which this request's gated pass
        did not already check. A walk that cannot finish refuses as retryable
        rather than minting blind: a payer told to try again in a moment is
        better off than one handed a second address to pay."""
        now = self._clock()
        checked = (
            {str(check.get("payment_hash", "")).lower() for check in reconcile_pass["checks"]}
            if reconcile_pass is not None
            and reconcile_pass.get("reason") == "ran"
            and reconcile_pass.get("checks")
            else set()
        )
        earlier = [
            ReconcilableAttempt(
                payment_hash=record.payment_hash,
                created_at=record.created_at,
                # The invoice's own expiry, never a swap's deposit deadline.
                expires_at=settlement_expires_at(record.checkout, record.payment_hash),
                created_at_source=str(record.checkout.get("created_at_source", "host")),
            )
            for record in self.repository.list_for_reference(reference)
            if record.status == "pending" and record.payment_hash.lower() not in checked
        ]
        earlier = [
            attempt
            for attempt in earlier
            if attempt.expires_at + EARLIER_ATTEMPT_LOOKBACK_SECONDS > now
        ]
        if not earlier:
            return
        deadline = time.monotonic() + RECONCILE_SCAN_TIMEOUT_SECONDS
        try:
            checks = self.reconciler.reconcile_attempts(earlier, deadline=deadline)
            settled = any(check.get("status") == "settled" for check in checks)
            decided = {str(check.get("payment_hash", "")).lower() for check in checks}
            undecided = [a for a in earlier if a.payment_hash.lower() not in decided]
            # A walk the deadline cut short omits what it could not reach.
            if not settled and undecided and time.monotonic() >= deadline:
                raise TimeoutError(
                    f"no answer within {RECONCILE_SCAN_TIMEOUT_SECONDS} s "
                    f"for {len(undecided)} of {len(earlier)} attempts"
                )
        except Exception as error:
            log.warning(
                "[openreceive] could not check an order's earlier attempts before a new one "
                "(refused as retryable): %s",
                sanitize_failure_message(error),
            )
            raise ServiceError(
                503,
                "INTERNAL",
                "Could not confirm this order's earlier payment attempt. Please try again in a moment.",
                retryable=True,
            ) from error
        if settled:
            raise ConflictError("This reference is already paid.")

    def _settlement_hook(self, event: dict[str, Any]) -> None:
        self.reconciler.settle(event)

    # ------------------------------------------------------------- workers

    def reconcile(self, **kwargs: Any) -> list[dict[str, Any]]:
        return self.reconciler.reconcile(**kwargs)

    def maybe_reconcile(self) -> dict[str, Any]:
        return self.reconciler.maybe_reconcile()


def _paid_attempt(record: PaymentRecord) -> dict[str, Any]:
    """What the handler needs to answer `paid` for the attempt that paid a reference."""
    return {
        "payment_hash": record.payment_hash,
        "checkout": dict(record.checkout),
        "paid_at": record.paid_at,
        "swap": record.swap_data is not None,
    }


def _newest_pending(records: list[PaymentRecord]) -> PaymentRecord | None:
    """The attempt a picker opened on this reference watches: the newest one
    still pending, superseded or not, since a superseded invoice can still be
    paid. Any pending attempt would do (`paid` answers for the whole order);
    the newest is the one most likely still on the payer's wallet screen."""
    newest: PaymentRecord | None = None
    for record in records:
        if record.status != "pending":
            continue
        if newest is None or record.created_at > newest.created_at:
            newest = record
    return newest
