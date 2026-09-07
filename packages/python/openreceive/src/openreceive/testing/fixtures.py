"""The testkit fixture values, named once so a demo's `__testkit` routes and
the E2E suite read the same constants (docs/internal/testkit-contract.md)."""

from openreceive.testing.fake_swap_provider import (
    DEPOSIT_EXPIRY_SECONDS,
    INVOICE_EXPIRY_SECONDS,
    NETWORK_DEPOSIT_ADDRESS,
    PAY_AMOUNT,
    PROGRESS_ORDER,
)
from openreceive.testing.fake_wallet import DEFAULT_EXPIRY_SECONDS, PREIMAGE, RELAY, WALLET_PUBKEY

STATIC_BTC_USD_PRICE = "50000.00"  # a $1.00 button is 2,000 sats


def testkit_payment_hash(mint_number: int) -> str:
    return format(mint_number, "064x")


def testkit_invoice(mint_number: int) -> str:
    return f"lnbcopenreceive{mint_number:06d}"


def testkit_swap_order_id(create_number: int) -> str:
    return f"testkit-swap-{create_number}"


__all__ = [
    "DEFAULT_EXPIRY_SECONDS",
    "DEPOSIT_EXPIRY_SECONDS",
    "INVOICE_EXPIRY_SECONDS",
    "NETWORK_DEPOSIT_ADDRESS",
    "PAY_AMOUNT",
    "PREIMAGE",
    "PROGRESS_ORDER",
    "RELAY",
    "STATIC_BTC_USD_PRICE",
    "WALLET_PUBKEY",
    "testkit_invoice",
    "testkit_payment_hash",
    "testkit_swap_order_id",
]
