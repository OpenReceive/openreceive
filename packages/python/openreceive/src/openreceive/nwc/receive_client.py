"""The production `ReceiveNwcClient`: the in-repo transport
(`openreceive.nwc.transport`) wrapped with the kernel's request building,
reply normalization and error normalization. Twin of Ruby's
`NwcRubyReceiveClient`, with the relay session in-repo instead of a gem.

The transport is imported lazily so the kernel, the fakes and the vector
tests never load websockets/coincurve.
"""

from __future__ import annotations

import threading
from typing import Any

from openreceive.nwc import requests
from openreceive.nwc.client import NotificationHandler
from openreceive.nwc.errors import WalletError
from openreceive.nwc.uri import NwcConnection, parse_uri

# TransportError.kind → canonical error code (nwc/errors.py aliases the rest).
TRANSPORT_KIND_CODES = {
    "connect": "WALLET_UNAVAILABLE",
    "closed": "WALLET_UNAVAILABLE",
    "deadline": "TIMEOUT",
    "decrypt": "UNSUPPORTED_ENCRYPTION",
    "protocol": "OTHER",
}


class NwcReceiveClient:
    def __init__(
        self,
        connection_uri: str,
        *,
        transport: Any | None = None,
        deadline_seconds: float = 10.0,
    ) -> None:
        self.connection: NwcConnection = parse_uri(connection_uri)
        self.redacted_connection_uri = self.connection.redacted
        self._deadline_seconds = deadline_seconds
        self._transport = transport

    def __repr__(self) -> str:
        return f"NwcReceiveClient({self.redacted_connection_uri!r})"

    @property
    def transport(self) -> Any:
        if self._transport is None:
            from openreceive.nwc.transport import NwcTransport

            self._transport = NwcTransport(
                self.connection.wallet_pubkey,
                list(self.connection.relays),
                self.connection.client_secret,
                deadline_seconds=self._deadline_seconds,
            )
        return self._transport

    def preflight(self) -> dict[str, Any]:
        info = self._guard(lambda: self.transport.info())
        return dict(info) if isinstance(info, dict) else {}

    def make_invoice(self, params: dict[str, Any]) -> dict[str, Any]:
        nip47 = requests.make_invoice_request(params)
        return requests.normalize_make_invoice_response(self._request("make_invoice", nip47))

    def list_transactions(self, params: dict[str, Any]) -> dict[str, Any]:
        nip47 = requests.list_transactions_request(params)
        return requests.normalize_list_transactions_response(
            self._request("list_transactions", nip47)
        )

    def subscribe_notifications(
        self, handler: NotificationHandler, *, stop: threading.Event
    ) -> None:
        self._guard(lambda: self.transport.subscribe_notifications(handler, stop=stop))

    def close(self) -> None:
        if self._transport is not None:
            self._transport.close()

    def _request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        reply = self._guard(lambda: self.transport.request(method, params))
        data = dict(reply) if isinstance(reply, dict) else {}
        error = data.get("error")
        if isinstance(error, dict):
            raise WalletError(
                str(error.get("code") or "OTHER"),
                str(error.get("message") or "NWC wallet service returned an error."),
            )
        result = data.get("result")
        return dict(result) if isinstance(result, dict) else {}

    def _guard(self, call: Any) -> Any:
        try:
            return call()
        except WalletError:
            raise
        except Exception as error:
            kind = getattr(error, "kind", None)
            if isinstance(kind, str) and kind in TRANSPORT_KIND_CODES:
                raise WalletError(TRANSPORT_KIND_CODES[kind], str(error)) from error
            raise
