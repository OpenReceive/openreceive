"""Server-layer errors. Every error carries `status` and `code` so the handler
maps it to an error.schema.json body directly; codes come from the generated
error table, so an error without a canonical code is redacted to an opaque 500.
Twin of Ruby `OpenReceive::Server` errors."""

from __future__ import annotations

from typing import Any

from openreceive._generated.tables import ERROR_CODES, RETRYABLE_ERROR_CODES
from openreceive.nwc.uri import NWC_CODE_HELP_URL

__all__ = [
    "ERROR_CODES",
    "RETRYABLE_ERROR_CODES",
    "ConfigurationError",
    "ConflictError",
    "ForbiddenError",
    "HostPersistenceError",
    "InternalHostError",
    "MethodNotAllowedError",
    "NotFoundError",
    "NotImplementedHttpError",
    "PayloadTooLargeError",
    "RateLimitedError",
    "ServiceError",
    "SpendCapableWalletError",
    "UnsupportedMediaTypeError",
    "ValidationError",
    "WalletContractError",
    "WalletFailureError",
    "WalletPreflightError",
    "WalletUnavailableError",
]


class ServiceError(Exception):
    """An explicit HTTP status + canonical code (the JS serviceError)."""

    status: int
    code: str
    retryable: bool | None = None
    details: dict[str, Any] | None = None
    retry_after_seconds: int | None = None

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        retryable: bool | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable
        self.details = details


class ValidationError(ServiceError):
    def __init__(self, message: str = "Invalid request.") -> None:
        super().__init__(400, "INVALID_REQUEST", message)


class ForbiddenError(ServiceError):
    """FORBIDDEN, not UNAUTHORIZED: that name belongs to the NIP-47 wallet layer."""

    def __init__(self, message: str = "Forbidden.") -> None:
        super().__init__(403, "FORBIDDEN", message)


class NotFoundError(ServiceError):
    def __init__(self, message: str = "Not found.") -> None:
        super().__init__(404, "NOT_FOUND", message)


class ConflictError(ServiceError):
    def __init__(self, message: str = "Conflict.") -> None:
        super().__init__(409, "CONFLICT", message)


class MethodNotAllowedError(ServiceError):
    """A known path with the wrong method: INVALID_REQUEST, no Allow header (JS parity)."""

    def __init__(
        self, message: str = "This OpenReceive route does not support that HTTP method."
    ) -> None:
        super().__init__(405, "INVALID_REQUEST", message)


class InternalHostError(ServiceError):
    """500 INTERNAL raised deliberately (the host resolved an order without an
    amount): payer-safe by construction, so the message stays on the wire."""

    def __init__(self, message: str = "Internal server error.") -> None:
        super().__init__(500, "INTERNAL", message)


class HostPersistenceError(ServiceError):
    """Infrastructure failed to persist the attempt: a retryable INTERNAL,
    never a payer-blaming conflict; the invoice is withheld."""

    def __init__(
        self,
        message: str = "The host could not persist this payment attempt; payer instructions were withheld. Please retry.",
    ) -> None:
        super().__init__(503, "INTERNAL", message, retryable=True)


class PayloadTooLargeError(ServiceError):
    def __init__(self, message: str = "Request body is too large.") -> None:
        super().__init__(413, "INVALID_REQUEST", message)


class UnsupportedMediaTypeError(ServiceError):
    """The body-bearing routes accept application/json only — the
    CSRF-equivalent on cookie-authenticated mounts, rejected before authorize."""

    def __init__(self, message: str = "Request content type must be application/json.") -> None:
        super().__init__(415, "INVALID_REQUEST", message)


class RateLimitedError(ServiceError):
    def __init__(self, message: str = "Too many requests.") -> None:
        super().__init__(429, "RATE_LIMITED", message, retryable=True)
        self.retry_after_seconds = 60


class NotImplementedHttpError(ServiceError):
    def __init__(self, message: str = "Not implemented.") -> None:
        super().__init__(501, "NOT_IMPLEMENTED", message)


class WalletUnavailableError(ServiceError):
    def __init__(self, message: str = "NWC wallet service is unavailable.") -> None:
        super().__init__(503, "WALLET_UNAVAILABLE", message, retryable=True)


class WalletFailureError(ServiceError):
    """A wallet/relay failure normalized per the error-normalization vectors:
    a retryable outage is a 503, an upstream refusal a 502."""

    def __init__(self, normalized: dict[str, Any]) -> None:
        retryable = bool(normalized.get("retryable", False))
        super().__init__(
            503 if retryable else 502,
            str(normalized["code"]),
            str(normalized["message"]),
            retryable=retryable,
            details=normalized.get("details"),
        )


class WalletContractError(ServiceError):
    """The wallet responded but violated the receive-checkout contract."""

    def __init__(self, message: str = "Wallet violated the receive-checkout contract.") -> None:
        super().__init__(502, "UNSUPPORTED_METHOD", message)


class ConfigurationError(RuntimeError):
    """A host wiring problem (missing hook, unmigrated tables, bad NWC_URI)."""


class WalletPreflightError(ConfigurationError):
    def __init__(self, reason: str) -> None:
        super().__init__(
            f"OpenReceive wallet preflight failed: {reason} Use a receive-only NWC connection "
            f"advertising make_invoice and list_transactions. Get one here: {NWC_CODE_HELP_URL}"
        )


class SpendCapableWalletError(ConfigurationError):
    def __init__(self, methods: list[str]) -> None:
        super().__init__(
            "This NWC connection is NOT receive-only.\n"
            f"The wallet info event advertises spend method(s): {', '.join(methods)}.\n"
            "A leaked spend-capable NWC code lets an attacker drain the wallet, so OpenReceive refuses to boot with it.\n"
            f"Get a receive-only NWC code here: {NWC_CODE_HELP_URL}\n"
            "If this wallet cannot mint a receive-only code and you accept the risk, set "
            "allow_spend_capable_wallet=True (or OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true)."
        )
