"""NIP-47 request building and reply normalization (`nwc-request-response`,
`make-invoice-validation`, `amount-boundaries` vectors). Twin of the Ruby
`OpenReceive::Nwc` request/response functions.
"""

from __future__ import annotations

import json
from typing import Any

from openreceive import money
from openreceive._generated.tables import NWC_METADATA_MAX_BYTES
from openreceive.values import (
    HEX_64_PATTERN,
    LOWER_HEX_64_PATTERN,
    compact,
    optional_int,
    present,
    stringify,
    to_int,
)

# The transaction states OpenReceive recognizes (the JS TransactionState union).
TRANSACTION_STATES = ("pending", "settled", "expired", "failed", "accepted")


def json_bytes(value: object) -> int:
    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


def make_invoice_request(request: object) -> dict[str, Any]:
    data = stringify(request)
    if present(data.get("description")) and present(data.get("description_hash")):
        raise ValueError("description and description_hash cannot both be set")
    if "description_hash" in data and HEX_64_PATTERN.match(str(data["description_hash"])) is None:
        raise ValueError("description_hash must be 64 hex characters")
    result: dict[str, Any] = {"amount": money.bounded_msats(data["amount_msats"])}
    if "description" in data:
        result["description"] = data["description"]
    if "description_hash" in data:
        result["description_hash"] = data["description_hash"]
    if "expiry" in data:
        result["expiry"] = to_int(data["expiry"])
    if "metadata" in data:
        if json_bytes(data["metadata"]) > NWC_METADATA_MAX_BYTES:
            raise ValueError("metadata is too large")
        result["metadata"] = data["metadata"]
    return result


def unwrap(value: object) -> object:
    data = stringify(value)
    return data["result"] if "result" in data else value


def normalize_make_invoice_response(response: object) -> dict[str, Any]:
    data = stringify(unwrap(response))
    return compact(
        {
            "invoice": data["invoice"],
            "payment_hash": str(data.get("payment_hash") or data.get("paymentHash") or "").lower(),
            "amount_msats": to_int(
                data["amount_msats"] if data.get("amount_msats") is not None else data["amount"]
            ),
            "created_at": optional_int(_first(data, "created_at", "createdAt")),
            "expires_at": optional_int(_first(data, "expires_at", "expiresAt")),
        }
    )


def list_transactions_request(request: object) -> dict[str, Any]:
    data = stringify(request)
    result: dict[str, Any] = {}
    for key in ("from", "until", "offset", "limit"):
        if key in data:
            result[key] = to_int(data[key])
    if "type" in data:
        result["type"] = data["type"]
    if "unpaid" in data:
        result["unpaid"] = data["unpaid"]
    # limit must be a positive integer; no hard page cap here (the engine's own
    # scans use TRANSACTION_PAGE_LIMIT, the mapper passes callers' limits through).
    if "limit" in result and result["limit"] <= 0:
        raise ValueError("limit must be a positive integer")
    return result


def normalize_list_transactions_response(response: object) -> dict[str, Any]:
    unwrapped = unwrap(response)
    data = stringify(unwrapped)
    rows: list[object]
    if isinstance(data.get("transactions"), list):
        rows = list(data["transactions"])
    elif isinstance(unwrapped, list):
        rows = list(unwrapped)
    elif unwrapped is None or (hasattr(unwrapped, "items") and not data):
        # A genuinely empty reply is an empty scan.
        rows = []
    else:
        # A non-empty reply in a shape we do not recognize must NOT read as an
        # empty scan: an empty-looking scan at/after expiry+grace closes
        # pending attempts as expired. Fail the scan loudly instead.
        raise ValueError("list_transactions returned an unrecognized result shape")
    # One quirky wallet row must never reject the whole scan (a rejected scan
    # can neither settle nor close attempts — a livelock while the bad row
    # stays inside the window). Bad rows are skipped and counted.
    transactions: list[dict[str, Any]] = []
    skipped = 0
    for row in rows:
        try:
            transactions.append(normalize_transaction(row))
        except (KeyError, ValueError, TypeError):
            skipped += 1
    # ALL rows unusable is the unrecognized-shape case wearing a different hat.
    if not transactions and skipped:
        raise ValueError("list_transactions returned no usable rows")
    result: dict[str, Any] = {"transactions": transactions}
    if skipped:
        result["skipped_rows"] = skipped
    return result


def normalize_transaction(transaction: object) -> dict[str, Any]:
    data = stringify(transaction)
    return compact(
        {
            "type": data.get("type"),
            "invoice": data.get("invoice"),
            "payment_hash": _optional_payment_hash(_first(data, "payment_hash", "paymentHash")),
            "amount_msats": optional_int(_first(data, "amount_msats", "amount")),
            "transaction_state": transaction_state(data),
            "created_at": optional_int(_first(data, "created_at", "createdAt")),
            "expires_at": optional_int(_first(data, "expires_at", "expiresAt")),
            "settled_at": optional_int(_first(data, "settled_at", "settledAt")),
            "fees_paid_msats": optional_int(_first(data, "fees_paid", "feesPaid")),
            "preimage": data.get("preimage"),
        }
    )


def transaction_state(data: dict[str, Any]) -> str | None:
    """Recognized states pass through lowercased; a wallet that signals
    settlement only via boolean settled/paid flags maps to "settled"."""
    raw = _first(data, "transaction_state", "transactionState", "state")
    if isinstance(raw, str) and raw.lower() in TRANSACTION_STATES:
        return raw.lower()
    if data.get("settled") is True or data.get("paid") is True:
        return "settled"
    return None


def _first(data: dict[str, Any], *keys: str) -> object:
    for key in keys:
        value = data.get(key)
        if value is not None:
            return value
    return None


def _optional_payment_hash(value: object) -> str | None:
    """ABSENT means absent — a row minted by another app through the same
    wallet legitimately carries no hash. PRESENT but not 64 hex is a row we do
    not understand; it raises so the scan skips and counts it."""
    if value is None or value == "":
        return None
    hash_text = str(value).lower()
    if LOWER_HEX_64_PATTERN.match(hash_text) is None:
        raise ValueError("payment_hash must be 64 hexadecimal characters")
    return hash_text
