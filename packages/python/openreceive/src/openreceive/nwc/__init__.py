"""NIP-47 kernel rows: URI parse/redaction, wallet info summary, request
building + reply normalization, and error normalization. The relay transport
lives in `openreceive.nwc.transport` and is imported only by the receive client."""

from openreceive.nwc.client import NotificationHandler, ReceiveNwcClient
from openreceive.nwc.errors import WalletError, normalize_wallet_error
from openreceive.nwc.info import summarize
from openreceive.nwc.requests import (
    list_transactions_request,
    make_invoice_request,
    normalize_list_transactions_response,
    normalize_make_invoice_response,
    normalize_transaction,
)
from openreceive.nwc.uri import (
    NWC_CODE_HELP_URL,
    NwcConnection,
    NwcUriParseError,
    parse_uri,
    redact_uri,
)

__all__ = [
    "NWC_CODE_HELP_URL",
    "NotificationHandler",
    "NwcConnection",
    "NwcUriParseError",
    "ReceiveNwcClient",
    "WalletError",
    "list_transactions_request",
    "make_invoice_request",
    "normalize_list_transactions_response",
    "normalize_make_invoice_response",
    "normalize_transaction",
    "normalize_wallet_error",
    "parse_uri",
    "redact_uri",
    "summarize",
]
