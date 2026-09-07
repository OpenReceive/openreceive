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

from openreceive.server.errors import ConfigurationError, ConflictError, NotFoundError
from openreceive.server.handler import HookContext, HttpRequest, HttpResponse, RequestHandler
from openreceive.server.hosts import Host, price_description, price_only
from openreceive.server.rate_limit import built_in_rate_limit
from openreceive.server.reconcile import Reconciler
from openreceive.server.service import Service
from openreceive.storage.repository import (
    AttemptConflict,
    PaymentInsert,
    PaymentRepository,
    selected_for,
)

log = logging.getLogger("openreceive")

PRICING_ACTIONS = ("checkout.prepare", "swap.quote", "checkout.create", "swap.create")
QUOTE_ACTIONS = ("checkout.prepare", "swap.quote")


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
        if opportunistic_reconcile is not False and not hasattr(repository, "claim_reconcile_gate"):
            # The default settlement path never degrades silently.
            raise ConfigurationError(
                "opportunistic_reconcile (on by default) needs repository.claim_reconcile_gate — a durable CAS gate "
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
        if action in QUOTE_ACTIONS:
            return resolved
        requested_hash = body.get("payment_hash") if isinstance(body, Mapping) else None
        records = self.repository.list_for_reference(reference)
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

    def _settlement_hook(self, event: dict[str, Any]) -> None:
        self.reconciler.settle(event)

    # ------------------------------------------------------------- workers

    def reconcile(self, **kwargs: Any) -> list[dict[str, Any]]:
        return self.reconciler.reconcile(**kwargs)

    def maybe_reconcile(self) -> dict[str, Any]:
        return self.reconciler.maybe_reconcile()
