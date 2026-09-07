"""The one exception the transport raises."""

from __future__ import annotations

from typing import Literal

TransportErrorKind = Literal["connect", "deadline", "closed", "decrypt", "protocol"]


class TransportError(Exception):
    """A relay, deadline, decryption, or protocol failure.

    ``kind`` tells the engine how to react: ``connect``/``deadline`` mean
    retry later, ``closed`` means the long-lived socket ended (back off and
    resubscribe), ``decrypt``/``protocol`` mean the wallet or relay sent
    something this client cannot use.
    """

    def __init__(self, kind: TransportErrorKind, message: str) -> None:
        super().__init__(message)
        self.kind: TransportErrorKind = kind
        self.message = message

    def __str__(self) -> str:
        return f"{self.kind}: {self.message}"
