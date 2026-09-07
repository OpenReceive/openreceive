"""Exact money: fiat → msats quoting and the shared amount boundaries.

Twin of the Ruby `OpenReceive::Money` module and the JS `core/src/money`.
Decimal arithmetic runs under an explicit context — never the global default,
which another library in the same worker may have changed — and the quote
rounds UP to whole sats (`fiat-to-msats.usd` vectors). Msats are ints.
"""

from __future__ import annotations

import re
from decimal import ROUND_CEILING, Context, Decimal, InvalidOperation

from openreceive._generated.tables import MAX_AMOUNT_MSATS, MIN_AMOUNT_MSATS

# 28 significant digits with round-up: the ceiling of the rounded quotient is
# the ceiling of the exact quotient whenever the result fits 28 digits, which
# every bounded amount does.
MONEY_CONTEXT = Context(prec=28, rounding=ROUND_CEILING)
DECIMAL_PATTERN = re.compile(r"\A[0-9]+(?:\.[0-9]+)?\Z")
SATS_PER_BTC = 100_000_000


def decimal(value: object, field: str) -> Decimal:
    text = str(value if value is not None else "")
    if DECIMAL_PATTERN.match(text) is None:
        raise ValueError(f"{field} must be a positive decimal string")
    try:
        parsed = Decimal(text)
    except InvalidOperation:  # pragma: no cover - the pattern already excludes this
        raise ValueError(f"{field} must be a positive decimal string")
    if parsed <= 0:
        raise ValueError(f"{field} must be greater than zero")
    return parsed


def quote_fiat_to_sats(fiat_value: object, btc_fiat_price: object) -> int:
    fiat = decimal(fiat_value, "fiat.value")
    price = decimal(btc_fiat_price, "btc_fiat_price")
    quotient = MONEY_CONTEXT.divide(MONEY_CONTEXT.multiply(fiat, Decimal(SATS_PER_BTC)), price)
    return int(quotient.to_integral_value(rounding=ROUND_CEILING))


def quote_fiat_to_msats(fiat_value: object, btc_fiat_price: object) -> int:
    # Bounded like every other amount path: a large enough fiat value at a low
    # enough price otherwise produces an amount past the wire's 2^53-1 ceiling.
    return bounded_msats(quote_fiat_to_sats(fiat_value, btc_fiat_price) * 1000)


def direct_to_msats(currency: str, value: object) -> int:
    amount = decimal(value, "amount.value")
    if currency == "BTC":
        sats = amount * SATS_PER_BTC
    elif currency in ("SAT", "SATS"):
        sats = amount
    else:
        raise ValueError("amount.currency must be BTC, SAT, or SATS")
    if sats != sats.to_integral_value():
        raise ValueError("amount must resolve to whole satoshis")
    return bounded_msats(int(sats) * 1000)


def bounded_msats(value: object) -> int:
    if isinstance(value, bool):
        raise TypeError("amount_msats must be an integer")
    if isinstance(value, int):
        amount = value
    elif isinstance(value, str) and re.fullmatch(r"\s*[+-]?[0-9]+\s*", value):
        amount = int(value)
    elif isinstance(value, float) and value == int(value):
        amount = int(value)
    else:
        raise TypeError("amount_msats must be an integer")
    if not MIN_AMOUNT_MSATS <= amount <= MAX_AMOUNT_MSATS:
        raise ValueError("amount_msats is outside the safe range")
    return amount
