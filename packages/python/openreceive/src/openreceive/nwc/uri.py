"""NWC connection URI parse + redaction (`nwc-uri-parse` vectors). Twin of
Ruby `OpenReceive::Nwc.parse_uri` / `redact_uri` and the JS parseNwcUri: the
same error codes for the same failures.
"""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import parse_qsl, unquote, urlsplit

from openreceive.values import HEX_64_PATTERN

NWC_CODE_HELP_URL = "https://openreceive.org/get_a_nwc_code_to_receive_payments"
SCHEME = "nostr+walletconnect"


class NwcUriParseError(ValueError):
    def __init__(self, code: str, message: str, uri: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.redacted = None if uri is None else redact_uri(uri)


@dataclass(frozen=True)
class NwcConnection:
    wallet_pubkey: str
    relays: tuple[str, ...]
    client_secret: str
    redacted: str
    lud16: str | None = None

    def __repr__(self) -> str:  # the secret never reaches a log line
        return f"NwcConnection(redacted={self.redacted!r})"


def _valid_relay_url(relay: str) -> bool:
    try:
        parts = urlsplit(relay)
    except ValueError:
        return False
    return parts.scheme == "wss" and bool(parts.hostname)


def parse_uri(uri: object) -> NwcConnection:
    if not isinstance(uri, str) or not uri.strip():
        raise NwcUriParseError("invalid_uri", "Invalid NWC URI.")
    scheme, separator, rest = uri.partition(":")
    if not separator or scheme.lower() != SCHEME:
        raise NwcUriParseError("invalid_scheme", "NWC URI must use nostr+walletconnect.", uri)
    # Both spellings are accepted: `nostr+walletconnect://<pubkey>?...` (the
    # WHATWG URL exposes the pubkey as the host) and the opaque
    # `nostr+walletconnect:<pubkey>?...` form.
    rest = rest.split("#", 1)[0]
    wallet, _, query = rest.partition("?")
    wallet = wallet.lstrip("/")
    if not wallet:
        raise NwcUriParseError(
            "missing_wallet_pubkey", "NWC URI is missing the wallet public key.", uri
        )
    if HEX_64_PATTERN.match(wallet) is None:
        raise NwcUriParseError(
            "invalid_wallet_pubkey", "NWC wallet public key must be 64 hex characters.", uri
        )
    pairs = parse_qsl(query, keep_blank_values=True)
    relays = [value for key, value in pairs if key == "relay"]
    secrets = [value for key, value in pairs if key == "secret"]
    if not relays:
        raise NwcUriParseError("missing_relay", "NWC URI must include at least one relay.", uri)
    for relay in relays:
        if not _valid_relay_url(relay):
            raise NwcUriParseError("invalid_relay", "NWC relay URLs must be valid wss URLs.", uri)
    if not secrets or not secrets[0]:
        raise NwcUriParseError("missing_secret", "NWC URI is missing the client secret.", uri)
    if len(secrets) != 1 or HEX_64_PATTERN.match(secrets[0]) is None:
        raise NwcUriParseError(
            "invalid_secret", "NWC client secret must be 64 hex characters.", uri
        )
    lud16 = next((value for key, value in pairs if key == "lud16" and value), None)
    return NwcConnection(
        wallet_pubkey=wallet,
        relays=tuple(relays),
        client_secret=secrets[0],
        redacted=redact_uri(uri),
        lud16=lud16,
    )


def redact_uri(uri: object) -> str:
    """Redact every query pair whose PERCENT-DECODED key is `secret`; every
    other pair keeps its original bytes."""
    text = str(uri if uri is not None else "")
    query_start = text.find("?")
    if query_start < 0:
        return text
    fragment_start = text.find("#", query_start + 1)
    query_end = len(text) if fragment_start < 0 else fragment_start
    query = text[query_start + 1 : query_end]
    redacted: list[str] = []
    for pair in query.split("&"):
        key, separator, _ = pair.partition("=")
        if separator and unquote(key).lower() == "secret":
            redacted.append(f"{key}=[REDACTED]")
        else:
            redacted.append(pair)
    return f"{text[: query_start + 1]}{'&'.join(redacted)}{text[query_end:]}"
