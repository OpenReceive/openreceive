"""Wallet error normalization (`error-normalization` vectors): any wallet or
library failure becomes the canonical error body shape
`{code, message, retryable, request_id?, details?}`. Twin of Ruby
`OpenReceive::Nwc.normalize_wallet_error`.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

from openreceive._generated.tables import ERROR_CODES, RETRYABLE_ERROR_CODES
from openreceive.values import as_string_keys, compact

# Wallet/library spellings that map onto canonical codes.
ERROR_CODE_ALIASES = {
    "ABORT_ERROR": "TIMEOUT",
    "BAD_REQUEST": "INVALID_REQUEST",
    "CONNECTION_ERROR": "WALLET_UNAVAILABLE",
    "EXPIRED": "INVOICE_EXPIRED",
    "FETCH_ERROR": "WALLET_UNAVAILABLE",
    "FORBIDDEN": "RESTRICTED",
    "INVOICE_NOT_FOUND": "NOT_FOUND",
    "INVALID_PARAMETER": "INVALID_REQUEST",
    "INVALID_PARAMETERS": "INVALID_REQUEST",
    "INVALID_PARAMS": "INVALID_REQUEST",
    "METHOD_NOT_FOUND": "UNSUPPORTED_METHOD",
    "NETWORK_ERROR": "WALLET_UNAVAILABLE",
    "NIP47_NETWORK_ERROR": "WALLET_UNAVAILABLE",
    "NOSTR_NETWORK_ERROR": "WALLET_UNAVAILABLE",
    "NOT_AUTHORIZED": "UNAUTHORIZED",
    "NOT_SUPPORTED": "UNSUPPORTED_METHOD",
    "NOTFOUND": "NOT_FOUND",
    "PERMISSION_DENIED": "RESTRICTED",
    "RELAY_CONNECTION_ERROR": "WALLET_UNAVAILABLE",
    "REQUEST_TIMEOUT": "TIMEOUT",
    "SERVICE_UNAVAILABLE": "WALLET_UNAVAILABLE",
    "TIMED_OUT": "TIMEOUT",
    "TIMEOUT_ERROR": "TIMEOUT",
    "UNKNOWN_METHOD": "UNSUPPORTED_METHOD",
    "UNSUPPORTED": "UNSUPPORTED_METHOD",
    "UNSUPPORTED_ENCRYPTION_MODE": "UNSUPPORTED_ENCRYPTION",
    "WALLET_OFFLINE": "WALLET_UNAVAILABLE",
    "WALLET_UNREACHABLE": "WALLET_UNAVAILABLE",
}

ERROR_MESSAGES = {
    "NOT_IMPLEMENTED": "NWC wallet service does not implement this method.",
    "RESTRICTED": "NWC wallet service restricted this request.",
    "UNAUTHORIZED": "NWC wallet service rejected authorization.",
    "FORBIDDEN": "The host application did not authorize this request.",
    "RATE_LIMITED": "NWC wallet service rate limited this request.",
    "QUOTA_EXCEEDED": "NWC wallet service quota was exceeded.",
    "INTERNAL": "NWC wallet service returned an internal error.",
    "UNSUPPORTED_ENCRYPTION": "NWC wallet service does not support the required encryption mode.",
    "OTHER": "NWC wallet service returned an unknown error.",
    "NOT_FOUND": "NWC wallet service could not find the requested resource.",
    "TIMEOUT": "NWC wallet service request timed out.",
    "INVALID_REQUEST": "OpenReceive sent an invalid NWC wallet request.",
    "WALLET_UNAVAILABLE": "NWC wallet service is unavailable.",
    "INVOICE_EXPIRED": "NWC wallet reported that the invoice is expired.",
    "UNSUPPORTED_METHOD": "NWC wallet service does not support the requested method.",
    "CONFLICT": "NWC wallet service reported a conflicting request.",
}


class WalletError(Exception):
    """A wallet/relay failure already carrying a canonical (or alias) code —
    what the receive client raises when a NIP-47 reply carries `error`."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        retryable: bool | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.details = details


def normalize_error_code(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    normalized = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value.strip())
    normalized = re.sub(r"[^a-zA-Z0-9]+", "_", normalized).strip("_").upper()
    # Aliases first: a wallet's own "FORBIDDEN" is a wallet restriction
    # (RESTRICTED), never the host application's FORBIDDEN.
    if normalized in ERROR_CODE_ALIASES:
        return ERROR_CODE_ALIASES[normalized]
    return normalized if normalized in ERROR_CODES else None


def normalize_wallet_error(raw: object) -> dict[str, Any]:
    records = collect_error_records(raw)
    code = (
        _code_from_records(records)
        or (normalize_error_code(raw) if isinstance(raw, str) else None)
        or "OTHER"
    )
    retryable = _first_boolean(records, "retryable")
    if retryable is None:
        retryable = code in RETRYABLE_ERROR_CODES
    details = next(
        (record["details"] for record in records if isinstance(record.get("details"), Mapping)),
        None,
    )
    return compact(
        {
            "code": code,
            "message": _message_from(records, raw, code),
            "retryable": retryable,
            "request_id": _first_string(records, ("request_id", "requestId")),
            "details": dict(details) if details is not None else None,
        }
    )


def collect_error_records(value: object, seen: set[int] | None = None) -> list[dict[str, Any]]:
    seen = set() if seen is None else seen
    if value is None or id(value) in seen:
        return []
    seen.add(id(value))
    records: list[dict[str, Any]] = []
    if isinstance(value, BaseException):
        record: dict[str, Any] = {"name": type(value).__name__, "message": str(value)}
        code = getattr(value, "code", None)
        if code is not None:
            record["code"] = code
        for attribute in ("retryable", "request_id", "details"):
            item = getattr(value, attribute, None)
            if item is not None:
                record[attribute] = item
        records.append(record)
        if value.__cause__ is not None:
            records.extend(collect_error_records(value.__cause__, seen))
    elif isinstance(value, Mapping):
        record = as_string_keys(value)
        records.append(record)
        for key in ("error", "cause", "data"):
            if record.get(key) is not None:
                records.extend(collect_error_records(record[key], seen))
    return records


def _code_from_records(records: list[dict[str, Any]]) -> str | None:
    for record in records:
        direct = next(
            (
                normalized
                for normalized in (
                    normalize_error_code(record.get(key))
                    for key in ("code", "error_code", "errorCode", "type")
                )
                if normalized is not None
            ),
            None,
        )
        if direct is not None and direct != "OTHER":
            return direct
        name = normalize_error_code(record.get("name"))
        if name is not None and name != "OTHER":
            return name
        if direct is not None:
            return direct
    return None


def _message_from(records: list[dict[str, Any]], raw: object, code: str) -> str:
    message = _first_string(records, ("message", "description", "reason"))
    if message is not None and normalize_error_code(message) != code:
        return message
    if isinstance(raw, str) and normalize_error_code(raw) is None and raw.strip():
        return raw.strip()
    return ERROR_MESSAGES[code]


def _first_string(records: list[dict[str, Any]], keys: tuple[str, ...]) -> str | None:
    for record in records:
        for key in keys:
            value = record.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _first_boolean(records: list[dict[str, Any]], key: str) -> bool | None:
    for record in records:
        value = record.get(key)
        if value is True or value is False:
            return value
    return None
