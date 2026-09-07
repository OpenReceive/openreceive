"""The host contract: `amount_for(reference)`, `authorize(context)`,
`on_paid(settlement)` (inside the settlement transaction) and the optional
`after_paid(settlement)` (after COMMIT). Plus the two named placeholders the
scaffold writes: the engine detects them at boot and says out loud that the
install still logs instead of fulfilling / lets anyone holding a reference
mint, poll and refund for it."""

from __future__ import annotations

import logging
import warnings
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from openreceive.server.handler import HookContext
from openreceive.storage.repository import PaymentSettlement

log = logging.getLogger("openreceive")

AmountFor = Callable[[str], Any]
Authorize = Callable[[HookContext], bool]
OnPaid = Callable[[PaymentSettlement], None]


def LOGGING_ON_PAID(settlement: PaymentSettlement) -> None:  # noqa: N802 - a named constant, by design
    """The scaffolded placeholder `on_paid`: logs the settlement and fulfills
    nothing. Detected at boot; orders recorded as settled without ever being
    fulfilled must not pass silently."""
    log.info(
        "[openreceive] reference %s paid (payment_hash %s)",
        settlement.reference,
        settlement.payment_hash,
    )


def ALLOW_ALL_AUTHORIZE(_context: HookContext) -> bool:  # noqa: N802 - a named constant, by design
    """The scaffolded placeholder `authorize`: possession of the reference is
    the authorization. Fine for the five-minute demo; the engine warns."""
    return True


@dataclass
class Host:
    amount_for: AmountFor
    authorize: Authorize
    on_paid: OnPaid
    after_paid: OnPaid | None = None

    def placeholder_warnings(self) -> list[str]:
        lines: list[str] = []
        if self.on_paid is LOGGING_ON_PAID:
            lines.append(
                "on_paid is the generated placeholder (logging-only): settled orders are recorded but never "
                "fulfilled. Replace it with your fulfillment. https://openreceive.org/guides/api-reference.md"
            )
        if self.authorize is ALLOW_ALL_AUTHORIZE:
            lines.append(
                "authorize is the generated placeholder (allow-all): anyone holding a reference can mint invoices, "
                "poll status and request refunds for it. Bind it to the payer's session. "
                "https://openreceive.org/guides/authorization.md"
            )
        return lines

    def warn_about_placeholders(self) -> None:
        for line in self.placeholder_warnings():
            warnings.warn(f"[openreceive] {line}", stacklevel=3)
            log.warning("[openreceive] %s", line)


def price_only(price: Any) -> Any:
    """The price alone: a display string beside it must not reach the amount resolver."""
    if isinstance(price, dict):
        return {key: value for key, value in price.items() if key != "description"}
    return price


def price_description(price: Any) -> str | None:
    if not isinstance(price, dict):
        return None
    value = price.get("description")
    if not isinstance(value, str):
        return None
    return value.strip() or None
