"""The FixedFloat public XML rates export (the bulk feed for all pairs):
GET <base>/rates/fixed.xml, no API key, no weight budget. OpenReceive keeps
only Lightning-payout pairs matching its pay-in list in process memory and
derives indicative quotes / min-max locally; /create remains authoritative.
All amount math is exact integer fixed-point. Twin of Ruby `Swap::FixedFloatRates`."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from typing import Any

from openreceive.swap import assets
from openreceive.swap.http import HttpTransport, is_timeout_error

DECIMAL_PATTERN = re.compile(r"\A[0-9]+(\.[0-9]+)?\Z")
SATS_PER_BTC = 100_000_000
MAX_SAFE_INTEGER = 9_007_199_254_740_991
REFRESH_SECONDS = 15
MAX_STALE_SECONDS = REFRESH_SECONDS


class RatesFeedError(RuntimeError):
    pass


def pair_key(from_code: object, to_code: object) -> str:
    return f"{str(from_code or '').strip().upper()}:{str(to_code or '').strip().upper()}"


def xml_path(rate_type: str = "fixed") -> str:
    return f"/rates/{rate_type}.xml"


def rates_meta_key(provider_name: str, rate_type: str = "fixed") -> str:
    return f"swap_rates:{provider_name}:{rate_type}"


def fetch_index(
    *,
    base_url: str,
    now: Callable[[], int],
    http: HttpTransport,
    rate_type: str = "fixed",
    request_timeout_ms: int = 10_000,
) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}{xml_path(rate_type)}"
    try:
        response = http(
            method="GET",
            url=url,
            headers={"Accept": "application/xml, text/xml, */*"},
            body=None,
            timeout_ms=request_timeout_ms,
        )
    except Exception as error:
        if is_timeout_error(error):
            raise RatesFeedError(f"FixedFloat rates {rate_type}.xml request timed out.")
        raise RatesFeedError(
            f"FixedFloat rates {rate_type}.xml request failed before a response was received."
        )
    status = int(response["status"])
    if not 200 <= status <= 299:
        raise RatesFeedError(f"FixedFloat rates {rate_type}.xml failed with HTTP {status}.")
    return {
        "fetched_at": now(),
        "pairs": retain_lightning_payout_pairs(parse_xml(str(response["body"]))),
    }


def retain_lightning_payout_pairs(pairs: dict[str, dict[str, str]]) -> dict[str, dict[str, str]]:
    return {key: pair for key, pair in pairs.items() if assets.is_lightning_network(pair["to"])}


def retain_pairs_for_keys(index: dict[str, Any], pair_keys: list[str]) -> dict[str, Any]:
    pairs = {key: index["pairs"][key] for key in pair_keys if key in index["pairs"]}
    return {"fetched_at": index["fetched_at"], "pairs": pairs}


def parse_xml(xml: str) -> dict[str, dict[str, str]]:
    pairs: dict[str, dict[str, str]] = {}
    for item in _match_tags(xml, "item"):
        fields = {
            tag: _read_tag_text(item, tag)
            for tag in ("from", "to", "in", "out", "amount", "minamount", "maxamount")
        }
        if any(value is None for value in fields.values()):
            continue
        pair = {
            "from": str(fields["from"]).strip(),
            "to": str(fields["to"]).strip(),
            "in": _strip_currency_suffix(str(fields["in"])),
            "out": _strip_currency_suffix(str(fields["out"])),
            "amount": _strip_currency_suffix(str(fields["amount"])),
            "minamount": _strip_currency_suffix(str(fields["minamount"])),
            "maxamount": _strip_currency_suffix(str(fields["maxamount"])),
        }
        tofee = _read_tag_text(item, "tofee")
        if tofee is not None:
            pair["tofee"] = tofee.strip()
        pairs[pair_key(pair["from"], pair["to"])] = pair
    return pairs


def serialize_index(index: dict[str, Any]) -> str:
    return json.dumps({"fetched_at": index["fetched_at"], "pairs": index["pairs"]})


def deserialize_index(value: str) -> dict[str, Any]:
    parsed = json.loads(value)
    fetched_at = parsed.get("fetched_at") if isinstance(parsed, dict) else None
    raw_pairs = parsed.get("pairs") if isinstance(parsed, dict) else None
    if not isinstance(fetched_at, int) or not isinstance(raw_pairs, dict):
        raise RatesFeedError("Invalid FixedFloat rates cache blob.")
    pairs: dict[str, dict[str, str]] = {}
    for key, raw in raw_pairs.items():
        pair = _read_stored_pair(raw)
        if pair is not None:
            pairs[str(key)] = pair
    return {"fetched_at": fetched_at, "pairs": pairs}


def quote_pay_amount(pair: dict[str, Any], invoice_amount_msats: object) -> str | None:
    """Indicative pay-in amount for a Lightning payout: pay_from =
    (invoice_btc + tofee_btc) × (in / out), rounded UP at 8 decimals so the
    UI never understates what /create is likely to require."""
    if (
        not isinstance(invoice_amount_msats, int)
        or isinstance(invoice_amount_msats, bool)
        or invoice_amount_msats <= 0
    ):
        return None
    rate_in = parse_positive_decimal(pair.get("in"))
    rate_out = parse_positive_decimal(pair.get("out"))
    if rate_in is None or rate_out is None:
        return None
    invoice_sats = (invoice_amount_msats + 999) // 1000
    tofee_sats = parse_tofee_btc_sats(pair.get("tofee")) or 0
    total_sats = invoice_sats + tofee_sats
    pay_at_8dp = ceil_div(total_sats * rate_in[0] * rate_out[1], rate_in[1] * rate_out[0])
    return format_decimal(pay_at_8dp, SATS_PER_BTC, 8)


def invoice_limits(pair: dict[str, Any]) -> dict[str, Any]:
    """XML from-side min/max mapped into invoice-side msats: minimum rounds up,
    maximum rounds down, so borderline invoices never read as inside a range
    the provider rejects."""
    limits: dict[str, Any] = {
        "minimum_pay_amount": pair["minamount"],
        "maximum_pay_amount": pair["maxamount"],
    }
    minimum = pay_amount_to_invoice_msats(pair, pair["minamount"], "ceil")
    maximum = pay_amount_to_invoice_msats(pair, pair["maxamount"], "floor")
    if minimum is not None:
        limits["minimum_invoice_amount_msats"] = minimum
    if maximum is not None:
        limits["maximum_invoice_amount_msats"] = maximum
    return limits


def compare_decimal_amounts(left: object, right: object) -> int | None:
    a = parse_positive_decimal(left)
    b = parse_positive_decimal(right)
    if a is None or b is None:
        return None
    lhs, rhs = a[0] * b[1], b[0] * a[1]
    return (lhs > rhs) - (lhs < rhs)


def pay_amount_to_invoice_msats(
    pair: dict[str, Any], pay_amount: object, rounding: str
) -> int | None:
    pay = parse_positive_decimal(pay_amount)
    rate_in = parse_positive_decimal(pair.get("in"))
    rate_out = parse_positive_decimal(pair.get("out"))
    if pay is None or rate_in is None or rate_out is None:
        return None
    numerator = pay[0] * rate_out[0] * SATS_PER_BTC * rate_in[1]
    denominator = pay[1] * rate_out[1] * rate_in[0]
    if denominator <= 0:
        return None
    invoice_sats = (
        ceil_div(numerator, denominator) if rounding == "ceil" else numerator // denominator
    )
    if invoice_sats <= 0 or invoice_sats > MAX_SAFE_INTEGER:
        return None
    msats = invoice_sats * 1000
    return None if msats > MAX_SAFE_INTEGER else msats


def parse_tofee_btc_sats(tofee: object) -> int | None:
    if tofee is None:
        return None
    match = re.match(r"\A([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)?\Z", str(tofee).strip())
    if match is None:
        return None
    unit = (match.group(2) or "BTC").upper()
    if unit not in ("BTC", "BTCLN"):
        return None
    parsed = parse_positive_decimal(match.group(1))
    if parsed is None:
        return None
    return ceil_div(parsed[0] * SATS_PER_BTC, parsed[1])


def parse_positive_decimal(value: object) -> tuple[int, int] | None:
    """(integer, scale) for a positive decimal string, else None."""
    if not isinstance(value, str) or DECIMAL_PATTERN.match(value) is None:
        return None
    whole, _, fraction = value.partition(".")
    integer = int(f"{whole}{fraction}")
    if integer <= 0:
        return None
    return integer, 10 ** len(fraction)


def format_decimal(integer: int, scale: int, max_fraction_digits: int) -> str:
    whole = integer // scale
    fraction = integer % scale
    target_scale = 10**max_fraction_digits
    if scale > target_scale:
        divisor = scale // target_scale
        remainder = fraction % divisor
        fraction //= divisor
        if remainder > 0:
            fraction += 1
        if fraction >= target_scale:
            return format_decimal(
                whole * target_scale + fraction, target_scale, max_fraction_digits
            )
    elif scale < target_scale:
        fraction *= target_scale // scale
    fraction_text = str(fraction).rjust(max_fraction_digits, "0").rstrip("0")
    return str(whole) if not fraction_text else f"{whole}.{fraction_text}"


def ceil_div(numerator: int, denominator: int) -> int:
    return (numerator + denominator - 1) // denominator


def _strip_currency_suffix(value: str) -> str:
    match = re.match(r"\A([0-9]+(?:\.[0-9]+)?)", value.strip())
    return value.strip() if match is None else match.group(1)


def _match_tags(xml: str, tag: str) -> list[str]:
    return [
        match or ""
        for match in re.findall(rf"<{tag}\b[^>]*>(.*?)</{tag}>", xml, re.IGNORECASE | re.DOTALL)
    ]


def _read_tag_text(xml: str, tag: str) -> str | None:
    match = re.search(rf"<{tag}\b[^>]*>(.*?)</{tag}>", xml, re.IGNORECASE | re.DOTALL)
    if match is None:
        return None
    text = (match.group(1) or "").strip()
    return text or None


def _read_stored_pair(value: object) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    required = ("from", "to", "in", "out", "amount", "minamount", "maxamount")
    if not all(isinstance(value.get(key), str) for key in required):
        return None
    pair = {key: str(value[key]) for key in required}
    if isinstance(value.get("tofee"), str):
        pair["tofee"] = value["tofee"]
    return pair
