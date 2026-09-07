"""The framework-free HTTP handler: one `HttpRequest` in, one
`HttpResponse(status, body, headers)` out, with the routing, body cap,
content-type gate, cross-site refusal, declared-fields check and error
mapping of the Ruby `RackApp` + `RequestHandler` and the JS handler. The
Django views, the FastAPI router and the Flask recipe are thin adapters over
`RequestHandler.dispatch`; nothing about the wire lives in them.

Hooks (all callables the app layer wires from a `Host` + repository):
  authorize(context) -> bool          context.action / .request / .resource
  resolve_checkout(action=, request=, reference=, body=, pay_in_asset=) -> dict
      {"amount": ..., "description"?, "payment_hash"?, "checkout"?, "swap_data"?}
  on_checkout_created(reference=, payment_hash=, checkout=, swap_data=, client_ip=)
  on_paid({"payment_hash", "paid_at", "details"})
  rate_limit(context) -> bool         optional
  client_ip(request) -> str | None    optional; normalized into the shared bucket
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any, NamedTuple
from urllib.parse import parse_qsl

from openreceive.server import client_ip as client_ip_module
from openreceive.server.errors import (
    ERROR_CODES,
    RETRYABLE_ERROR_CODES,
    ConflictError,
    ForbiddenError,
    HostPersistenceError,
    InternalHostError,
    MethodNotAllowedError,
    NotFoundError,
    PayloadTooLargeError,
    RateLimitedError,
    UnsupportedMediaTypeError,
    ValidationError,
    WalletUnavailableError,
)
from openreceive.server.service import Service
from openreceive.values import as_string_keys, stringify

log = logging.getLogger("openreceive")

MAX_REFERENCE_LENGTH = 200
MAX_MEMO_LENGTH = 500
MAX_BODY_BYTES = 64 * 1024
# Route paths (method-independent): a known path with the wrong method is a
# 405 rather than a 404 — mirrors the JS router.
KNOWN_PATHS = (
    "/checkouts/prepare",
    "/checkouts",
    "/payments/check",
    "/swaps/quote",
    "/swaps",
    "/swaps/status",
    "/swaps/refunds",
    "/rates",
)
# Declared fields per route (additionalProperties: false, snake_case only).
ROUTE_BODY_FIELDS = {
    "checkout.prepare": ("reference",),
    "checkout.create": ("reference", "memo", "metadata"),
    "payment.check": ("reference", "payment_hash"),
    "swap.quote": ("reference", "pay_in_asset"),
    "swap.create": ("reference", "pay_in_asset", "memo", "metadata"),
    "swap.read": ("reference", "payment_hash"),
    "swap.refund": ("reference", "payment_hash", "refund_address"),
}
# Payer-facing subset of a settlement's wallet details, field for field with
# the JS publicPaymentDetails. Never widen to preimage or invoice.
PUBLIC_TRANSACTION_FIELDS = (
    "payment_hash",
    "transaction_state",
    "amount_msats",
    "fees_paid_msats",
    "created_at",
    "settled_at",
    "expires_at",
)
UNMATCHED_ROUTE_MESSAGE = "No OpenReceive route matched this method and path."
NOT_AUTHORIZED_MESSAGE = (
    "Not authorized for this action. The application's authorize hook denied it; if this is unexpected, "
    "check that the payer's session reaches the checkout routes. https://openreceive.org/guides/authorization.md"
)

BodyReader = Callable[[int], bytes]


@dataclass
class HttpRequest:
    """The wire request every adapter builds. `path` is the full request path
    (prefix included, no query string). `headers` keys are matched
    case-insensitively. `body` is the raw bytes, or a reader called with the
    maximum number of bytes to read (so an unauthenticated payer can never
    stream an unbounded body into memory); it is read only after a route
    matched. `framework_request` is handed to the host's hooks untouched."""

    method: str
    path: str
    query_string: str = ""
    headers: Mapping[str, str] = field(default_factory=dict)
    body: bytes | BodyReader | None = None
    content_length: int | None = None
    remote_addr: str | None = None
    framework_request: Any = None

    def header(self, name: str) -> str | None:
        wanted = name.lower()
        for key, value in self.headers.items():
            if key.lower() == wanted:
                return value
        return None


class HttpResponse(NamedTuple):
    status: int
    body: dict[str, Any]
    headers: dict[str, str]

    def json(self) -> str:
        return json.dumps(self.body, separators=(",", ":"), ensure_ascii=False)


@dataclass(frozen=True)
class HookContext:
    """What `authorize` and `rate_limit` receive."""

    action: str
    request: Any
    resource: dict[str, Any]


ResolveCheckout = Callable[..., Mapping[str, Any] | None]


class RequestHandler:
    def __init__(
        self,
        *,
        service: Service,
        authorize: Callable[[HookContext], bool],
        resolve_checkout: ResolveCheckout,
        on_checkout_created: Callable[..., Any],
        on_paid: Callable[[dict[str, Any]], Any],
        rate_limit: Callable[[HookContext], bool] | None = None,
        client_ip: Callable[[Any], str | None] | None = None,
        prefix: str = "/openreceive",
        report_unexpected_error: Callable[[BaseException, str], None] | None = None,
    ) -> None:
        if authorize is None:
            raise ValueError(
                "authorize is required — authentication belongs to the host application. "
                "https://openreceive.org/guides/authorization.md"
            )
        self._service = service
        self._authorize = authorize
        self._resolve_checkout = resolve_checkout
        self._on_checkout_created = on_checkout_created
        self._on_paid = on_paid
        self._rate_limit = rate_limit
        raw_client_ip = client_ip or (lambda request: getattr(request, "remote_addr", None))
        # Stamped IPs are normalized into the bucket the limiter counts with.
        self._client_ip: Callable[[Any], str | None] = lambda request: client_ip_module.attributed(
            raw_client_ip(request)
        )
        self.prefix = prefix.rstrip("/")
        self._report_unexpected_error = report_unexpected_error

    # -------------------------------------------------------------- dispatch

    def dispatch(
        self,
        request: HttpRequest,
        *,
        reconcile_pass: dict[str, Any] | None = None,
        attempt_status: Callable[[str], dict[str, Any] | None] | None = None,
    ) -> HttpResponse:
        """Route the wire request. Always server-generated request ids: a
        client-supplied X-Request-Id is unvalidated content and never reflected.
        The body is read only after a route matches. Storage-aware callers pass
        `reconcile_pass` + `attempt_status` for payments/check (see check_payment)."""
        request_id = f"req_{uuid.uuid4()}"
        try:
            path = request.path or ""
            if not path.startswith(self.prefix):
                return self.error_response(NotFoundError(UNMATCHED_ROUTE_MESSAGE), request_id)
            relative = path[len(self.prefix) :]
            if relative.endswith("/"):
                relative = relative[:-1]
            method = (request.method or "").upper()
            route = (method, relative)
            if route == ("POST", "/checkouts/prepare"):
                return self.prepare_checkout(self._read_body(request), request, request_id)
            if route == ("POST", "/checkouts"):
                return self.create_checkout(self._read_body(request), request, request_id)
            if route == ("POST", "/payments/check"):
                return self.check_payment(
                    self._read_body(request),
                    request,
                    request_id,
                    reconcile_pass=reconcile_pass,
                    attempt_status=attempt_status,
                )
            if route == ("POST", "/swaps/quote"):
                return self.quote_swap(self._read_body(request), request, request_id)
            if route == ("POST", "/swaps"):
                return self.create_swap(self._read_body(request), request, request_id)
            if route == ("POST", "/swaps/status"):
                return self.get_swap(self._read_body(request), request, request_id)
            if route == ("POST", "/swaps/refunds"):
                return self.refund_swap(self._read_body(request), request, request_id)
            if route == ("GET", "/rates"):
                return self.read_rates(request.query_string, request, request_id)
            if relative in KNOWN_PATHS:
                return self.error_response(MethodNotAllowedError(), request_id)
            return self.error_response(NotFoundError(UNMATCHED_ROUTE_MESSAGE), request_id)
        except Exception as error:
            return self.error_response(error, request_id)

    @staticmethod
    def route_kind(request: HttpRequest, prefix: str = "/openreceive") -> str | None:
        """The action a request maps to, before dispatch — the app layer uses it
        to run the opportunistic reconcile on payment routes only (GET /rates is
        exempt: crawlers and health checks must not consume the scan budget)."""
        path = request.path or ""
        if not path.startswith(prefix.rstrip("/")):
            return None
        relative = path[len(prefix.rstrip("/")) :].rstrip("/")
        method = (request.method or "").upper()
        table = {
            ("POST", "/checkouts/prepare"): "checkout.prepare",
            ("POST", "/checkouts"): "checkout.create",
            ("POST", "/payments/check"): "payment.check",
            ("POST", "/swaps/quote"): "swap.quote",
            ("POST", "/swaps"): "swap.create",
            ("POST", "/swaps/status"): "swap.read",
            ("POST", "/swaps/refunds"): "swap.refund",
            ("GET", "/rates"): "rates",
        }
        return table.get((method, relative))

    def _read_body(self, request: HttpRequest) -> str:
        """Pre-auth body cap: an over-declared Content-Length is rejected before
        any read, and the read itself stops one byte past the cap."""
        if request.content_length is not None and request.content_length > MAX_BODY_BYTES:
            raise PayloadTooLargeError()
        declared = request.header("content-length")
        if declared is not None and declared.strip().isdigit() and int(declared) > MAX_BODY_BYTES:
            raise PayloadTooLargeError()
        body = request.body
        if body is None:
            return ""
        raw = body(MAX_BODY_BYTES + 1) if callable(body) else bytes(body)
        if len(raw) > MAX_BODY_BYTES:
            raise PayloadTooLargeError()
        return raw.decode("utf-8", errors="replace")

    # ---------------------------------------------------------------- routes

    def prepare_checkout(self, raw_body: str, request: Any, request_id: str) -> HttpResponse:
        try:
            body = self._parse(raw_body, "checkout.prepare", request)
            reference = self._required_reference(body)
            self._guard("checkout.prepare", request, {"reference": reference})
            resolved = self._resolve_host("checkout.prepare", request, reference, body)
            prepared = self._service.prepare_checkout({"amount": self._required_amount(resolved)})
            payload = {**prepared, "reference": reference}
            description = self._resolved_description(resolved)
            if description:
                payload["description"] = description
            return self._success(200, payload, request_id)
        except Exception as error:
            return self.error_response(error, request_id)

    def create_checkout(self, raw_body: str, request: Any, request_id: str) -> HttpResponse:
        try:
            body = self._parse(raw_body, "checkout.create", request)
            reference = self._required_reference(body)
            self._authorize_or_raise("checkout.create", request, {"reference": reference})
            resolved = self._resolve_host("checkout.create", request, reference, body)
            reusing = bool(resolved.get("payment_hash"))
            # Rate limits meter minting only: re-serving a committed attempt
            # costs no wallet call, so a capped payer can still re-fetch.
            if not reusing:
                self._enforce_rate_limit("checkout.create", request, {"reference": reference})
            if reusing:
                checkout = self._committed_checkout(reference, resolved)
            else:
                checkout = self._service.create_checkout(
                    {
                        "reference": reference,
                        "amount": self._required_amount(resolved),
                        "memo": self._validated_memo(body),
                        "metadata": body.get("metadata"),
                    }
                )
                self._commit(checkout, None, request)
            # The catalog rides along with the mint, amount-aware against this
            # attempt's committed invoice amount, on the re-fetch path too.
            payload: dict[str, Any] = {
                "checkout": checkout,
                "payment_methods": self._service.list_swap_options(checkout["amount_msats"]),
            }
            description = self._resolved_description(resolved)
            if description:
                payload["description"] = description
            return self._success(201, payload, request_id)
        except Exception as error:
            return self.error_response(error, request_id)

    def check_payment(
        self,
        raw_body: str,
        request: Any,
        request_id: str,
        *,
        reconcile_pass: dict[str, Any] | None = None,
        attempt_status: Callable[[str], dict[str, Any] | None] | None = None,
    ) -> HttpResponse:
        """Storage-aware callers pass `reconcile_pass` — the request-level gated
        reconcile result ({"reason": "ran", "checks": [...]} or a skip reason) —
        plus `attempt_status`, mapping a payment hash to its persisted
        {"status", "paid_at"?}. The requested hash is then served from the pass
        (winner) or the host row (gate_busy / outside the pending set /
        disabled) with `details` omitted — never a second per-invoice wallet
        walk. Storage-agnostic callers omit both and get a one-attempt walk."""
        try:
            body = self._parse(raw_body, "payment.check", request)
            reference = self._required_reference(body)
            # Payer input is shape-validated BEFORE any host hook runs.
            requested_hash = self._required_payment_hash(body.get("payment_hash"))
            self._guard(
                "payment.check", request, {"reference": reference, "payment_hash": requested_hash}
            )
            resolved = self._resolve_host("payment.check", request, reference, body)
            payment_hash = self._selected_payment_hash(resolved, requested_hash)
            checkout = self._committed_checkout(reference, resolved)
            if reconcile_pass is None:
                checked = self._checked_via_wallet(payment_hash, checkout)
            else:
                checked = self._checked_from_pass(payment_hash, reconcile_pass, attempt_status)
            payload = {
                **checked,
                "payment_methods": self._service.list_swap_options(checkout["amount_msats"]),
            }
            return self._success(200, payload, request_id)
        except Exception as error:
            return self.error_response(error, request_id)

    def quote_swap(self, raw_body: str, request: Any, request_id: str) -> HttpResponse:
        try:
            body = self._parse(raw_body, "swap.quote", request)
            reference = self._required_reference(body)
            asset = self._required(body.get("pay_in_asset"), "pay_in_asset")
            self._guard("swap.quote", request, {"reference": reference})
            resolved = self._resolve_host("swap.quote", request, reference, body, asset)
            quote = self._service.quote_swap(
                {"amount": self._required_amount(resolved), "pay_in_asset": asset}
            )
            return self._success(200, quote, request_id)
        except Exception as error:
            return self.error_response(error, request_id)

    def create_swap(self, raw_body: str, request: Any, request_id: str) -> HttpResponse:
        try:
            body = self._parse(raw_body, "swap.create", request)
            reference = self._required_reference(body)
            asset = self._required(body.get("pay_in_asset"), "pay_in_asset")
            self._authorize_or_raise("swap.create", request, {"reference": reference})
            resolved = self._resolve_host("swap.create", request, reference, body, asset)
            reusing = bool(resolved.get("payment_hash"))
            if not reusing:
                self._enforce_rate_limit("swap.create", request, {"reference": reference})
            if reusing:
                data = self._required_swap_data(resolved.get("swap_data"))
                status = self._service.get_swap(
                    reference=reference, payment_hash=str(resolved["payment_hash"]), swap_data=data
                )
                swap = {
                    **status,
                    "checkout": self._committed_checkout(reference, resolved),
                    "swap_data": data,
                }
            else:
                # Explicit, validated fields only: the raw payer body never
                # reaches the service.
                swap = self._service.create_swap(
                    {
                        "reference": reference,
                        "amount": self._required_amount(resolved),
                        "pay_in_asset": asset,
                        "memo": self._validated_memo(body),
                        "metadata": body.get("metadata"),
                    }
                )
                self._commit(swap["checkout"], swap.get("swap_data"), request)
            return self._success(
                201,
                {"swap": {key: value for key, value in swap.items() if key != "swap_data"}},
                request_id,
            )
        except Exception as error:
            return self.error_response(error, request_id)

    def get_swap(self, raw_body: str, request: Any, request_id: str) -> HttpResponse:
        return self._swap_action(
            "swap.read",
            raw_body,
            request,
            request_id,
            lambda reference, payment_hash, data, _body: self._service.get_swap(
                reference=reference, payment_hash=payment_hash, swap_data=data
            ),
        )

    def refund_swap(self, raw_body: str, request: Any, request_id: str) -> HttpResponse:
        return self._swap_action(
            "swap.refund",
            raw_body,
            request,
            request_id,
            lambda reference, payment_hash, data, body: self._service.refund_swap(
                reference=reference,
                payment_hash=payment_hash,
                swap_data=data,
                refund_address=self._required(body.get("refund_address"), "refund_address"),
            ),
        )

    def read_rates(self, query_string: str | None, request: Any, request_id: str) -> HttpResponse:
        try:
            pairs = parse_qsl(query_string or "", keep_blank_values=True)
            raw = next((value for key, value in pairs if key == "currencies"), None)
            currencies = self._parse_rates_currencies(raw)
            payload = self._service.list_rates(
                {} if currencies is None else {"currencies": currencies}
            )
            return self._success(200, payload, request_id)
        except Exception as error:
            return self.error_response(error, request_id)

    @staticmethod
    def _parse_rates_currencies(raw: str | None) -> list[str] | None:
        """The payer's ?currencies filter, checked at the wire boundary with the
        JS message, so a malformed entry is a 400 in every engine rather than
        the service's rates-unavailable path."""
        if raw is None:
            return None
        currencies = [value.strip() for value in raw.split(",") if value.strip()]
        if not currencies or any(
            re.fullmatch(r"[A-Za-z]{3}", value) is None for value in currencies
        ):
            raise ValidationError(
                "currencies must be a comma-separated list of three-letter currency codes."
            )
        return currencies

    # ------------------------------------------------------------- errors

    def error_response(self, error: BaseException, request_id: str) -> HttpResponse:
        """Only an error carrying a code from the canonical contract enum keeps
        its status/code/message on the wire; anything else — a leaked library
        exception with its own `code` included — is redacted to an opaque 500."""
        code = getattr(error, "code", None)
        if not isinstance(code, str) or code not in ERROR_CODES:
            self._report(error, request_id)
            return HttpResponse(
                500,
                {"code": "INTERNAL", "message": "Internal server error.", "request_id": request_id},
                self._headers(request_id),
            )
        retryable = getattr(error, "retryable", None)
        status = getattr(error, "status", None)
        if status is None:
            # A canonical code without a status is the wallet shape.
            if retryable is None:
                retryable = code in RETRYABLE_ERROR_CODES
            status = 503 if retryable else 502
        body: dict[str, Any] = {"code": code, "message": str(error), "request_id": request_id}
        if retryable is not None:
            body["retryable"] = bool(retryable)
        details = getattr(error, "details", None)
        if isinstance(details, dict):
            body["details"] = details
        headers = self._headers(request_id)
        retry_after = getattr(error, "retry_after_seconds", None)
        if retry_after is not None:
            headers["retry-after"] = str(max(1, int(-(-float(retry_after) // 1))))
        return HttpResponse(int(status), body, headers)

    def _report(self, error: BaseException, request_id: str) -> None:
        """Redacting an unexpected exception must not also swallow it. The
        fallback log line carries class and origin only — never the message,
        which could quote request bodies, NWC URIs, invoices or preimages."""
        try:
            if self._report_unexpected_error is not None:
                self._report_unexpected_error(error, request_id)
                return
            origin = error.__traceback__
            where = ""
            if origin is not None:
                while origin.tb_next is not None:
                    origin = origin.tb_next
                where = f" at {origin.tb_frame.f_code.co_filename}:{origin.tb_lineno}"
            log.error(
                "[openreceive] unexpected %s (request_id=%s)%s",
                type(error).__name__,
                request_id,
                where,
            )
        except Exception:
            pass

    # ------------------------------------------------------------ helpers

    def _checked_via_wallet(self, payment_hash: str, checkout: dict[str, Any]) -> dict[str, Any]:
        """One-attempt reconcile_payments, delivering settlement inline. A
        truncated walk is a retryable 503 rather than not_found."""
        results = self._service.reconcile_payments(
            {"attempts": [{"payment_hash": payment_hash, "created_at": checkout["created_at"]}]}
        )
        if not results:
            raise WalletUnavailableError(
                "payment reconciliation did not complete: the wallet history walk ended before this invoice could be confirmed"
            )
        checked = results[0]
        if checked.get("status") == "settled" and checked.get("paid_at"):
            self._on_paid(
                {
                    "payment_hash": checked["payment_hash"],
                    "paid_at": checked["paid_at"],
                    "details": checked.get("details"),
                }
            )
        return self._public_checked(checked)

    def _checked_from_pass(
        self,
        payment_hash: str,
        reconcile_pass: dict[str, Any],
        attempt_status: Callable[[str], dict[str, Any] | None] | None,
    ) -> dict[str, Any]:
        if reconcile_pass.get("reason") == "ran":
            checked = next(
                (
                    check
                    for check in reconcile_pass.get("checks") or []
                    if str(check.get("payment_hash", "")).lower() == payment_hash
                ),
                None,
            )
            # A `not_found` pass result falls through to the row: a wallet that
            # ignores `unpaid: true` omits a live invoice from the scan.
            if checked is not None and checked.get("status") != "not_found":
                return self._public_checked(checked)
        row = attempt_status(payment_hash) if attempt_status is not None else None
        if row is None:
            raise NotFoundError("Payment attempt not found for this reference.")
        # Row `attention` serves as `pending` on the wire (operator state, not
        # payer information); the row path never emits `not_found`.
        status = "pending" if row.get("status") == "attention" else str(row.get("status"))
        public: dict[str, Any] = {"payment_hash": payment_hash, "status": status}
        if row.get("paid_at") is not None:
            public["paid_at"] = int(row["paid_at"])
        return public

    @classmethod
    def _public_checked(cls, checked: dict[str, Any]) -> dict[str, Any]:
        public = {key: value for key, value in checked.items() if key != "details"}
        if checked.get("details") is not None:
            public["details"] = cls._public_payment_details(checked["details"])
        return public

    @staticmethod
    def _public_payment_details(details: Any) -> dict[str, Any]:
        data = stringify(details)
        result: dict[str, Any] = {}
        transaction = data.get("transaction")
        if isinstance(transaction, Mapping):
            rows = as_string_keys(transaction)
            result["transaction"] = {
                field: rows[field]
                for field in PUBLIC_TRANSACTION_FIELDS
                if rows.get(field) is not None
            }
        result["observed_at"] = data.get("observed_at")
        if data.get("paid_at_source") is not None:
            result["paid_at_source"] = data["paid_at_source"]
        return result

    def _swap_action(
        self,
        action: str,
        raw_body: str,
        request: Any,
        request_id: str,
        perform: Callable[[str, str, dict[str, Any], dict[str, Any]], dict[str, Any]],
    ) -> HttpResponse:
        try:
            body = self._parse(raw_body, action, request)
            reference = self._required_reference(body)
            requested_hash = self._required_payment_hash(body.get("payment_hash"))
            self._guard(action, request, {"reference": reference, "payment_hash": requested_hash})
            resolved = self._resolve_host(action, request, reference, body)
            payment_hash = self._selected_payment_hash(resolved, requested_hash)
            result = perform(
                reference, payment_hash, self._required_swap_data(resolved.get("swap_data")), body
            )
            return self._success(200, result, request_id)
        except Exception as error:
            return self.error_response(error, request_id)

    @staticmethod
    def hook_request(request: Any) -> Any:
        """Hooks receive the framework's own request object when the adapter
        supplied one (`HttpRequest.framework_request`), else the wire request."""
        if isinstance(request, HttpRequest) and request.framework_request is not None:
            return request.framework_request
        return request

    def _resolve_host(
        self,
        action: str,
        request: Any,
        reference: str,
        body: dict[str, Any],
        pay_in_asset: str | None = None,
    ) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "action": action,
            "request": self.hook_request(request),
            "reference": reference,
            "body": body,
        }
        if pay_in_asset is not None:
            kwargs["pay_in_asset"] = pay_in_asset
        return stringify(self._resolve_checkout(**kwargs))

    def _guard(self, action: str, request: Any, resource: dict[str, Any]) -> None:
        self._enforce_rate_limit(action, request, resource)
        self._authorize_or_raise(action, request, resource)

    def _enforce_rate_limit(self, action: str, request: Any, resource: dict[str, Any]) -> None:
        if self._rate_limit is None:
            return
        if not self._rate_limit(
            HookContext(action=action, request=self.hook_request(request), resource=resource)
        ):
            raise RateLimitedError()

    def _authorize_or_raise(self, action: str, request: Any, resource: dict[str, Any]) -> None:
        if self._authorize(
            HookContext(action=action, request=self.hook_request(request), resource=resource)
        ):
            return
        raise ForbiddenError(NOT_AUTHORIZED_MESSAGE)

    def _commit(
        self, checkout: dict[str, Any], swap_data: dict[str, Any] | None, request: Any
    ) -> None:
        try:
            self._on_checkout_created(
                reference=checkout["reference"],
                payment_hash=checkout["payment_hash"],
                checkout=checkout,
                swap_data=swap_data,
                client_ip=self._client_ip(self.hook_request(request)),
            )
        except Exception as error:
            # Meaningful repository refusals carry their own status/code and pass
            # through; anything else is infrastructure failing to persist.
            if hasattr(error, "status") and hasattr(error, "code"):
                raise
            raise HostPersistenceError() from error

    def _parse(self, raw: str, route: str, request: HttpRequest | Any) -> dict[str, Any]:
        self._assert_not_cross_site(request)
        self._assert_json_content_type(request)
        text = raw or ""
        if len(text.encode("utf-8")) > MAX_BODY_BYTES:
            raise PayloadTooLargeError()
        try:
            value = {} if not text.strip() else json.loads(text)
        except json.JSONDecodeError:
            raise ValidationError("Request body must be a JSON object.")
        if not isinstance(value, dict):
            raise ValidationError("Request body must be a JSON object.")
        self._assert_declared_fields(value, route)
        return value

    @staticmethod
    def _header(request: Any, name: str) -> str | None:
        if isinstance(request, HttpRequest):
            return request.header(name)
        headers = getattr(request, "headers", None)
        if isinstance(headers, Mapping):
            for key, value in headers.items():
                if str(key).lower() == name.lower():
                    return str(value)
        return None

    def _assert_json_content_type(self, request: Any) -> None:
        """The body-bearing routes accept application/json only, checked before
        authorize or any host hook: a cross-site HTML form cannot set a JSON
        content type, and a cross-origin fetch that does is CORS-preflighted —
        which the library never answers. Parameters and charset are ignored."""
        content_type = self._header(request, "content-type") or ""
        if content_type.split(";", 1)[0].strip().lower() == "application/json":
            return
        raise UnsupportedMediaTypeError()

    def _assert_not_cross_site(self, request: Any) -> None:
        """Browsers label a forged request from another site `Sec-Fetch-Site:
        cross-site` — including a no-cors fetch the content-type gate alone
        cannot see. `same-site` and an absent header pass."""
        site = (self._header(request, "sec-fetch-site") or "").strip().lower()
        if site == "cross-site":
            raise ForbiddenError("Cross-site requests are not accepted.")

    @staticmethod
    def _assert_declared_fields(body: dict[str, Any], route: str) -> None:
        allowed = ROUTE_BODY_FIELDS.get(route)
        if allowed is None:
            return
        # A payer-supplied amount is the one undeclared field worth naming.
        if "amount" in body or "amount_msats" in body:
            raise ValidationError(
                "This route does not accept a payer-supplied amount; the host resolves its order price."
            )
        for key in body:
            if key not in allowed:
                raise ValidationError(f"Unexpected request field for this route: {key}.")

    @staticmethod
    def _required(value: object, field: str) -> str:
        text = str(value if value is not None else "").strip()
        if not text:
            raise ValidationError(f"{field} is required.")
        return text

    def _required_reference(self, body: dict[str, Any]) -> str:
        reference = self._required(body.get("reference"), "reference")
        if len(reference) > MAX_REFERENCE_LENGTH:
            raise ValidationError(f"reference must be {MAX_REFERENCE_LENGTH} characters or fewer.")
        return reference

    @staticmethod
    def _validated_memo(body: dict[str, Any]) -> Any:
        memo = body.get("memo")
        if isinstance(memo, str) and len(memo) > MAX_MEMO_LENGTH:
            raise ValidationError(f"memo must be {MAX_MEMO_LENGTH} characters or fewer.")
        return memo

    @staticmethod
    def _resolved_description(resolved: dict[str, Any]) -> str | None:
        """What the payer is buying, in the host's own words. Response only."""
        value = resolved.get("description")
        if not isinstance(value, str):
            return None
        return value.strip() or None

    @staticmethod
    def _required_amount(resolved: dict[str, Any]) -> Any:
        amount = resolved.get("amount")
        if amount is None:
            # A host order without an amount is a host bug, not a payer mistake.
            raise InternalHostError("The host resolved this order without an amount.")
        return amount

    def _required_payment_hash(self, value: object) -> str:
        payment_hash = self._required(value, "payment_hash").lower()
        if re.fullmatch(r"[0-9a-f]{64}", payment_hash) is None:
            raise ValidationError("payment_hash must be 64 hexadecimal characters.")
        return payment_hash

    @staticmethod
    def _required_swap_data(value: object) -> dict[str, Any]:
        if value is None:
            raise NotFoundError("The host order has no swap data.")
        if not isinstance(value, Mapping):
            raise ValidationError("The host order's swap data is not a valid swap_data object.")
        return as_string_keys(value)

    def _selected_payment_hash(self, resolved: dict[str, Any], requested_hash: str) -> str:
        selected = self._host_payment_hash(resolved.get("payment_hash"))
        if selected == requested_hash:
            return selected
        raise NotFoundError("The selected payment attempt does not belong to this order.")

    @staticmethod
    def _host_payment_hash(value: object) -> str:
        """A payment hash the HOST resolver returned: a missing or malformed
        value is a host integration bug, surfaced as a 500 naming the host."""
        payment_hash = value.strip().lower() if isinstance(value, str) else None
        if payment_hash is not None and re.fullmatch(r"[0-9a-f]{64}", payment_hash):
            return payment_hash
        raise InternalHostError(
            "The host resolver returned a missing or malformed payment hash for this reference."
        )

    def _committed_checkout(self, reference: str, resolved: dict[str, Any]) -> dict[str, Any]:
        checkout = resolved.get("checkout")
        if not isinstance(checkout, Mapping):
            raise ConflictError("The host payment attempt has no checkout snapshot.")
        data = as_string_keys(checkout)
        try:
            payment_hash = self._host_payment_hash(data.get("payment_hash"))
            selected = self._host_payment_hash(resolved.get("payment_hash"))
            checkout_reference = self._required(data.get("reference"), "reference")
        except (ValueError, TypeError):
            raise ConflictError("The selected payment attempt is not a reusable pending checkout.")
        if payment_hash != selected or checkout_reference != reference:
            raise ConflictError("The selected payment attempt is not a reusable pending checkout.")
        return data

    def _success(self, status: int, body: dict[str, Any], request_id: str) -> HttpResponse:
        return HttpResponse(status, body, self._headers(request_id))

    @staticmethod
    def _headers(request_id: str) -> dict[str, str]:
        return {"content-type": "application/json; charset=utf-8", "x-request-id": request_id}
