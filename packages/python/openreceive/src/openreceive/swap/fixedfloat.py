"""The production FixedFloat(-compatible) swap provider: HMAC-signed API calls
over an injectable HTTP transport, quote/create/status/refund flows, and the
same order normalization as the JS and Ruby engines. The status mapping is the
generated decision table, interpreted in `openreceive.swap.state`.

Orders are string-keyed dicts with the shared SwapOrder field names
(provider, provider_order_id, provider_token, pay_in_asset, deposit_address,
deposit_amount, expires_at, state, ...). `provider_token` is server-only.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from collections.abc import Callable
from decimal import Decimal
from fractions import Fraction
from typing import Any

from openreceive.swap import assets, rates_feed
from openreceive.swap import state as swap_state
from openreceive.swap.budget import SwapProviderWeightBudget
from openreceive.swap.cache import MAX_STALE_SECONDS, TransientSwapCache, limits_meta_key
from openreceive.swap.http import HttpTransport, default_http_request, is_timeout_error
from openreceive.values import compact

DEFAULT_BASE_URL = "https://ff.io"
DEFAULT_CCIES_CACHE_SECONDS = 24 * 60 * 60
DEFAULT_RATES_CACHE_SECONDS = rates_feed.REFRESH_SECONDS
DEFAULT_REQUEST_TIMEOUT_MS = 10_000
DEFAULT_DEPOSIT_WINDOW_SECONDS = 10 * 60
DEFAULT_SETTLEMENT_SLA_SECONDS = 15 * 60
# Margin above deposit_window + settlement_sla: five minutes keeps the shadow
# invoice alive through a plausible 30-minute provider order.
DEFAULT_INVOICE_EXPIRY_MARGIN_SECONDS = 5 * 60
PROVIDER_ID_PATTERN = re.compile(r"\A[a-z0-9][a-z0-9_-]{0,63}\Z")

ApiLogger = Callable[[dict[str, Any]], None]


class FixedFloatApiError(RuntimeError):
    """Deliberately carries no `status`/`code`: the request handler duck-types
    those for wire mapping, and a provider failure must reach the payer as the
    redacted 500 "Internal server error." exactly like the JS engine."""

    KINDS = ("api", "http", "invalid_json", "network", "rate_limited", "timeout")

    def __init__(
        self,
        *,
        path: str,
        kind: str,
        message: str,
        http_status: int | None = None,
        fixedfloat_code: object = None,
        fixedfloat_message: str | None = None,
    ) -> None:
        super().__init__(message)
        self.path = path
        self.kind = kind
        self.http_status = http_status
        self.fixedfloat_code = fixedfloat_code
        self.fixedfloat_message = fixedfloat_message

    @classmethod
    def from_transport_error(cls, path: str, error: BaseException) -> FixedFloatApiError:
        aborted = is_timeout_error(error)
        return cls(
            path=path,
            kind="timeout" if aborted else "network",
            message=(
                f"FixedFloat {path} request timed out."
                if aborted
                else f"FixedFloat {path} request failed before a response was received."
            ),
        )


class FixedFloatProviderError(RuntimeError):
    """A provider contract break (a missing field, an unsupported asset)."""


def availability_message(reason: str) -> str:
    return {
        "amount_too_small": "This invoice is below the provider minimum.",
        "amount_too_large": "This invoice is above the provider maximum.",
        "provider_rate_limited": "The swap provider is rate limited.",
        "provider_unreachable": "The swap provider is temporarily unreachable.",
    }.get(reason, "This payment route is temporarily unavailable.")


def classify_quote_error(error: BaseException) -> str:
    if getattr(error, "weight_budget", False) is True:
        return "provider_rate_limited"
    if isinstance(error, FixedFloatApiError):
        if error.kind == "rate_limited" or error.http_status == 429:
            return "provider_rate_limited"
        if error.kind in ("timeout", "network", "invalid_json") or (
            error.http_status is not None and error.http_status >= 500
        ):
            return "provider_unreachable"
        message = (error.fixedfloat_message or str(error)).lower()
        if _amount_too_small_message(message):
            return "amount_too_small"
        if _amount_too_large_message(message):
            return "amount_too_large"
        return "pair_temporarily_unavailable"
    message = str(error).lower()
    if "rate" in message or "429" in message or "weight budget" in message:
        return "provider_rate_limited"
    if "fetch" in message or "network" in message or "timeout" in message:
        return "provider_unreachable"
    if _amount_too_small_message(message):
        return "amount_too_small"
    if _amount_too_large_message(message):
        return "amount_too_large"
    return "pair_temporarily_unavailable"


def _amount_too_small_message(message: str) -> bool:
    return any(token in message for token in ("min", "small", "out of limits", "limit_min"))


def _amount_too_large_message(message: str) -> bool:
    return any(token in message for token in ("max", "large", "limit_max"))


class FixedFloatProvider:
    def __init__(
        self,
        *,
        key: str,
        secret: str,
        id: str = "fixedfloat",
        base_url: str | None = None,
        lightning_ccy: str | None = None,
        http: HttpTransport | None = None,
        now: Callable[[], int] | None = None,
        cache_seconds: int | None = None,
        rates_cache_seconds: int | None = None,
        request_timeout_ms: int | None = None,
        invoice_expiry_seconds: int | None = None,
        deposit_window_seconds: int | None = None,
        settlement_sla_seconds: int | None = None,
        invoice_expiry_margin_seconds: int | None = None,
    ) -> None:
        self.name = self.read_provider_id(id)
        if not str(key or "").strip():
            raise ValueError("FixedFloat-compatible API key must not be empty.")
        if not str(secret or "").strip():
            raise ValueError("FixedFloat-compatible API secret must not be empty.")
        self._key = key
        self._secret = secret
        self._base_url = (base_url or DEFAULT_BASE_URL).rstrip("/")
        self._lightning_ccy = (lightning_ccy or "").strip() or None
        self._http: HttpTransport = http or default_http_request
        self._now: Callable[[], int] = now or (lambda: int(time.time()))
        self._cache_seconds = cache_seconds or DEFAULT_CCIES_CACHE_SECONDS
        self._rates_cache_seconds = rates_cache_seconds or DEFAULT_RATES_CACHE_SECONDS
        if not isinstance(self._rates_cache_seconds, int) or self._rates_cache_seconds <= 0:
            raise ValueError("FixedFloat rates_cache_seconds must be a positive safe integer.")
        self._request_timeout_ms = request_timeout_ms or DEFAULT_REQUEST_TIMEOUT_MS
        if not isinstance(self._request_timeout_ms, int) or self._request_timeout_ms <= 0:
            raise ValueError("FixedFloat request_timeout_ms must be a positive safe integer.")
        deposit_window = (
            DEFAULT_DEPOSIT_WINDOW_SECONDS
            if deposit_window_seconds is None
            else deposit_window_seconds
        )
        settlement_sla = (
            DEFAULT_SETTLEMENT_SLA_SECONDS
            if settlement_sla_seconds is None
            else settlement_sla_seconds
        )
        margin = (
            DEFAULT_INVOICE_EXPIRY_MARGIN_SECONDS
            if invoice_expiry_margin_seconds is None
            else invoice_expiry_margin_seconds
        )
        for label, value in (
            ("FixedFloat deposit_window_seconds", deposit_window),
            ("FixedFloat settlement_sla_seconds", settlement_sla),
            ("FixedFloat invoice_expiry_margin_seconds", margin),
        ):
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"{label} must be a non-negative safe integer.")
        minimum_expiry = deposit_window + settlement_sla + margin
        self._invoice_expiry_seconds = (
            minimum_expiry if invoice_expiry_seconds is None else invoice_expiry_seconds
        )
        if (
            not isinstance(self._invoice_expiry_seconds, int)
            or self._invoice_expiry_seconds < minimum_expiry
        ):
            raise ValueError(
                f"FixedFloat provider {self.name!r}: invoice_expiry_seconds "
                f"({self._invoice_expiry_seconds}) must be at least {minimum_expiry} = "
                f"deposit_window({deposit_window}) + settlement_sla({settlement_sla}) + "
                f"margin({margin}). Omit invoice_expiry_seconds to auto-derive it, or raise it above that floor."
            )
        self._cache: TransientSwapCache | None = None
        self._weight_budget: SwapProviderWeightBudget | None = None
        self._api_request_logger: ApiLogger | None = None
        self._api_response_logger: ApiLogger | None = None

    def __repr__(self) -> str:
        return f"FixedFloatProvider(name={self.name!r}, base_url={self._base_url!r})"

    @staticmethod
    def read_provider_id(id: object) -> str:
        normalized = str(id or "").strip()
        if PROVIDER_ID_PATTERN.match(normalized) is None:
            raise ValueError(
                "FixedFloat-compatible provider id must use lowercase letters, numbers, underscores, or hyphens."
            )
        return normalized

    # Runtime attachments (the service wires these; fakes need none of them).
    def attach_swap_cache(self, cache: TransientSwapCache) -> None:
        self._cache = cache

    def attach_weight_budget(self, budget: SwapProviderWeightBudget) -> None:
        self._weight_budget = budget

    def attach_api_request_logger(self, logger: ApiLogger) -> None:
        self._api_request_logger = logger

    def attach_api_response_logger(self, logger: ApiLogger) -> None:
        self._api_response_logger = logger

    # ------------------------------------------------------------ the contract

    def supported_pay_in_assets(self) -> list[str]:
        return list(self._resolve_currencies()["pay_in"].keys())

    def pay_in_asset_catalog(self) -> list[dict[str, Any]]:
        resolution = self._resolve_currencies()
        # /ccies carries no amount limits; per-pair min/max come from the
        # public XML rates export, cached in this process.
        rates = self._resolve_rates_index(resolution)
        lightning_code = resolution["lightning"]["code"]
        catalog: list[dict[str, Any]] = []
        for pay_in_asset, currency in resolution["pay_in"].items():
            pair = rates["pairs"].get(rates_feed.pair_key(currency["code"], lightning_code))
            if pair is None:
                catalog.append(
                    {
                        "pay_asset": pay_in_asset,
                        "available": False,
                        "unavailable_reason": "pair_temporarily_unavailable",
                        "unavailable_message": availability_message("pair_temporarily_unavailable"),
                    }
                )
            else:
                catalog.append({"pay_asset": pay_in_asset, **rates_feed.invoice_limits(pair)})
        return catalog

    def invoice_expiry_seconds(self, pay_in_asset: str | None = None) -> int:
        return self._invoice_expiry_seconds

    def quote(self, *, pay_in_asset: str, invoice_amount_msats: int) -> dict[str, Any]:
        # Indicative quote from the process-local XML rates cache; /create is
        # still the binding rate. Rates refresh failures raise (fail closed) so
        # the service can skip this provider and try the next LSC connection.
        resolution = self._resolve_currencies()
        from_ccy = self._required_currency(resolution, pay_in_asset)
        rates = self._resolve_rates_index(resolution)
        try:
            pair = rates["pairs"].get(
                rates_feed.pair_key(from_ccy, resolution["lightning"]["code"])
            )
            if pair is None:
                return self._unavailable_quote(pay_in_asset, "pair_temporarily_unavailable")
            limits = rates_feed.invoice_limits(pair)
            pay_amount = rates_feed.quote_pay_amount(pair, invoice_amount_msats)
            if pay_amount is None:
                return self._unavailable_quote(pay_in_asset, "pair_temporarily_unavailable", limits)
            pay_below_min = (
                rates_feed.compare_decimal_amounts(pay_amount, limits["minimum_pay_amount"]) == -1
            )
            pay_above_max = (
                rates_feed.compare_decimal_amounts(pay_amount, limits["maximum_pay_amount"]) == 1
            )
            minimum_msats = limits.get("minimum_invoice_amount_msats")
            maximum_msats = limits.get("maximum_invoice_amount_msats")
            too_small = pay_below_min or (
                minimum_msats is not None and invoice_amount_msats < minimum_msats
            )
            too_large = pay_above_max or (
                maximum_msats is not None and invoice_amount_msats > maximum_msats
            )
            if too_small or too_large:
                return self._unavailable_quote(
                    pay_in_asset, "amount_too_small" if too_small else "amount_too_large", limits
                )
            return {
                "pay_amount": pay_amount,
                "pay_asset": pay_in_asset,
                "available": True,
                "provider": self.name,
                **limits,
            }
        except Exception as error:
            # Pair-math / limit errors stay as unavailable quotes; rates and
            # network failures already raised above and are not swallowed here.
            return self._unavailable_quote(pay_in_asset, classify_quote_error(error))

    def create_swap(
        self, *, pay_in_asset: str, bolt11: str, invoice_amount_msats: int
    ) -> dict[str, Any]:
        resolution = self._resolve_currencies()
        from_ccy = self._required_currency(resolution, pay_in_asset)
        to_ccy = resolution["lightning"]["code"]
        data = self._post(
            "create",
            {
                "type": "fixed",
                "fromCcy": from_ccy,
                "toCcy": to_ccy,
                "direction": "to",
                "amount": self.amount_msats_to_btc_string(invoice_amount_msats),
                "toAddress": bolt11,
            },
        )
        order = self._normalize_order(data, pay_in_asset=pay_in_asset)
        if order.get("fee") is not None:
            return order
        # Backfill the USD equivalents that explain the swap fee from a
        # best-effort /price lookup; a failure just leaves the fee off.
        fee = self._fetch_order_fee(from_ccy, to_ccy, invoice_amount_msats)
        return order if fee is None else {**order, "fee": fee}

    def get_status(self, order: dict[str, Any]) -> dict[str, Any]:
        stored = dict(order)
        data = self._post(
            "order", {"id": stored["provider_order_id"], "token": stored["provider_token"]}
        )
        return {
            **stored,
            **self._normalize_order(data, pay_in_asset=stored.get("pay_in_asset"), fallback=stored),
        }

    def request_refund(self, order: dict[str, Any], refund_address: str) -> None:
        stored = dict(order)
        self._post(
            "emergency",
            {
                "id": stored["provider_order_id"],
                "token": stored["provider_token"],
                "choice": "REFUND",
                "address": refund_address,
            },
        )

    # ------------------------------------------------------------- internals

    def _unavailable_quote(
        self, pay_in_asset: str, reason: str, limits: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {
            "pay_asset": pay_in_asset,
            "available": False,
            "unavailable_reason": reason,
            "unavailable_message": availability_message(reason),
            "provider": self.name,
            **(limits or {}),
        }

    def _fetch_order_fee(
        self, from_ccy: str, to_ccy: str, invoice_amount_msats: int
    ) -> dict[str, Any] | None:
        try:
            data = self._post(
                "price",
                {
                    "type": "fixed",
                    "fromCcy": from_ccy,
                    "toCcy": to_ccy,
                    "direction": "to",
                    "amount": self.amount_msats_to_btc_string(invoice_amount_msats),
                },
            )
            return self.read_order_fee(_as_record(data))
        except Exception:
            return None

    def _post(self, path: str, body: dict[str, Any]) -> Any:
        if self._weight_budget is not None:
            self._weight_budget.reserve(path)
        body_string = json.dumps(body, separators=(",", ":"))
        # The API key and HMAC signature live in headers and are never logged;
        # the host sink is responsible for sanitizing nested secrets in bodies.
        self._log_api_request(path, body)
        try:
            response = self._http(
                method="POST",
                url=f"{self._base_url}/api/v2/{path}",
                headers={
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-API-KEY": self._key,
                    "X-API-SIGN": hmac.new(
                        self._secret.encode("utf-8"), body_string.encode("utf-8"), hashlib.sha256
                    ).hexdigest(),
                },
                body=body_string,
                timeout_ms=self._request_timeout_ms,
            )
        except Exception as error:
            api_error = FixedFloatApiError.from_transport_error(path, error)
            self._log_api_response(path=path, status=0, ok=False, msg=str(api_error))
            raise api_error from error
        status = int(response["status"])
        text = str(response.get("body") or "")
        ok = 200 <= status <= 299
        try:
            parsed = json.loads(text) if text.strip() else {}
            if not isinstance(parsed, dict):
                parsed = {}
        except json.JSONDecodeError:
            self._log_api_response(
                path=path, status=status, ok=False, msg=f"FixedFloat {path} returned invalid JSON."
            )
            raise FixedFloatApiError(
                path=path,
                kind="invalid_json",
                http_status=status,
                message=f"FixedFloat {path} returned invalid JSON.",
            )
        self._log_api_response(
            path=path,
            status=status,
            ok=ok,
            code=parsed.get("code"),
            msg=parsed.get("msg"),
            data=parsed.get("data"),
        )
        if not ok:
            if status == 429 and self._weight_budget is not None:
                self._weight_budget.mark_rate_limited()
            raise FixedFloatApiError(
                path=path,
                kind="rate_limited" if status == 429 else "http",
                http_status=status,
                fixedfloat_message=read_string(parsed.get("msg")),
                message=self.format_api_error_message(path, status, parsed.get("msg")),
            )
        if parsed.get("code") != 0:
            msg = parsed.get("msg")
            raise FixedFloatApiError(
                path=path,
                kind="api",
                fixedfloat_code=parsed.get("code"),
                fixedfloat_message=read_string(msg),
                message=msg if isinstance(msg, str) else f"FixedFloat {path} failed.",
            )
        return parsed.get("data")

    def _log_api_request(self, path: str, body: dict[str, Any] | None = None) -> None:
        if self._api_request_logger is None:
            return
        try:
            self._api_request_logger({"provider": self.name, "path": path, "body": body or {}})
        except Exception:
            pass

    def _log_api_response(
        self,
        *,
        path: str,
        status: int,
        ok: bool,
        code: object = None,
        msg: object = None,
        data: object = None,
    ) -> None:
        if self._api_response_logger is None:
            return
        try:
            self._api_response_logger(
                {
                    "provider": self.name,
                    "path": path,
                    "status": status,
                    "ok": ok,
                    "code": code,
                    "msg": msg,
                    "data": data,
                }
            )
        except Exception:
            pass

    def _resolve_currencies(self) -> dict[str, Any]:
        if self._cache is None:
            return self._fetch_currency_resolution()
        result: dict[str, Any] = self._cache.resolve(
            limits_meta_key(self.name),
            refresh_seconds=self._cache_seconds,
            max_stale_seconds=max(MAX_STALE_SECONDS, self._cache_seconds),
            fetch=self._fetch_currency_resolution,
            serialize=self.serialize_currency_resolution,
            deserialize=self.deserialize_currency_resolution,
        )
        return result

    def _resolve_rates_index(self, resolution: dict[str, Any]) -> dict[str, Any]:
        if self._cache is None:
            return self._fetch_rates_index(resolution)
        result: dict[str, Any] = self._cache.resolve(
            rates_feed.rates_meta_key(self.name, "fixed"),
            refresh_seconds=self._rates_cache_seconds,
            max_stale_seconds=max(rates_feed.MAX_STALE_SECONDS, self._rates_cache_seconds),
            # Crypto rates must not linger after a failed refresh — fail closed.
            serve_stale_on_failure=False,
            fetch=lambda: self._fetch_rates_index(resolution),
            serialize=rates_feed.serialize_index,
            deserialize=rates_feed.deserialize_index,
        )
        return result

    def _fetch_rates_index(self, resolution: dict[str, Any]) -> dict[str, Any]:
        path = rates_feed.xml_path("fixed").lstrip("/")
        self._log_api_request(path)
        try:
            fetched = rates_feed.fetch_index(
                base_url=self._base_url,
                rate_type="fixed",
                http=self._http,
                now=self._now,
                request_timeout_ms=self._request_timeout_ms,
            )
            index = rates_feed.retain_pairs_for_keys(fetched, self.rate_pair_keys(resolution))
            self._log_api_response(
                path=path, status=200, ok=True, data={"pair_count": len(index["pairs"])}
            )
            return index
        except Exception as error:
            self._log_api_response(path=path, status=0, ok=False, msg=str(error))
            raise

    def _fetch_currency_resolution(self) -> dict[str, Any]:
        now = self._now()
        currencies = self.read_currencies(self._post("ccies", {}))
        pay_in: dict[str, dict[str, Any]] = {}
        for asset in assets.list_info():
            found = next(
                (
                    currency
                    for currency in currencies
                    if currency["coin"].upper() == asset["coin"]
                    and assets.network_matches(asset["network"], currency["network"])
                    # /ccies recv=false: the provider will not accept deposits.
                    and currency.get("recv") is not False
                ),
                None,
            )
            if found is not None:
                pay_in[asset["pay_in_asset"]] = found
        if self._lightning_ccy is None:
            lightning = next(
                (
                    currency
                    for currency in currencies
                    if currency["coin"].upper() == "BTC"
                    and assets.is_lightning_network(currency["network"])
                    and currency.get("send") is not False
                ),
                None,
            )
        else:
            lightning = next(
                (
                    currency
                    for currency in currencies
                    if currency["code"] == self._lightning_ccy and currency.get("send") is not False
                ),
                None,
            )
        if lightning is None:
            raise FixedFloatProviderError(
                "FixedFloat /ccies did not include a BTC Lightning payout currency."
            )
        return {"fetched_at": now, "pay_in": pay_in, "lightning": lightning}

    def _required_currency(self, resolution: dict[str, Any], pay_in_asset: str) -> str:
        currency = resolution["pay_in"].get(pay_in_asset)
        if currency is None:
            raise FixedFloatProviderError(f"FixedFloat does not currently support {pay_in_asset}.")
        return str(currency["code"])

    def _normalize_order(
        self, data: Any, *, pay_in_asset: str | None, fallback: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        fallback = fallback or {}
        record = _as_record(data)
        from_side = _as_record(record.get("from"))
        time_block = _as_record(record.get("time"))
        refund_tx_id = (
            read_nested_string(record, ("back", "tx", "id"))
            or read_nested_string(record, ("refund", "tx", "id"))
            or fallback.get("refund_tx_id")
        )
        raw_status = read_string(record.get("status"))
        # A thin poll body with no "status" keeps the state we already
        # persisted VERBATIM: normalize_status speaks FixedFloat statuses, not
        # OpenReceive states.
        if raw_status is None and fallback:
            normalized_status = self.persisted_status(fallback)
        else:
            normalized_status = swap_state.normalize_status(
                raw_status or "NEW", _as_record(record.get("emergency")), refund_tx_id
            )
        order: dict[str, Any] = {
            "provider": self.name,
            "provider_order_id": read_string(record.get("id"))
            or fallback.get("provider_order_id")
            or required_string(record.get("id"), "id"),
            "provider_token": read_string(record.get("token"))
            or fallback.get("provider_token")
            or required_string(record.get("token"), "token"),
            "pay_in_asset": pay_in_asset,
            "deposit_address": read_string(from_side.get("address"))
            or fallback.get("deposit_address")
            or required_string(from_side.get("address"), "from.address"),
            "deposit_amount": read_string(from_side.get("amount"))
            or fallback.get("deposit_amount")
            or required_string(from_side.get("amount"), "from.amount"),
            # No invented deadline: the provider states the expiry, and on a
            # thin poll body the one we already persisted stands.
            "expires_at": self.required_expires_at(
                read_unix_seconds(time_block.get("expiration")) or fallback.get("expires_at")
            ),
            "state": normalized_status["state"],
        }
        order.update(self._optional_order_fields(record, normalized_status, refund_tx_id, fallback))
        order["raw"] = data
        return order

    def _optional_order_fields(
        self,
        record: dict[str, Any],
        normalized_status: dict[str, Any],
        refund_tx_id: str | None,
        fallback: dict[str, Any],
    ) -> dict[str, Any]:
        """Every order field OMITTED rather than sent as null when the provider
        did not report it — compacted in one place."""
        from_side = _as_record(record.get("from"))
        emergency_repeat = self.read_emergency_repeat(_as_record(record.get("emergency")))
        refund_reason = normalized_status.get("refund_reason")
        if refund_reason is None and swap_state.is_refund_path_state(normalized_status["state"]):
            refund_reason = fallback.get("refund_reason")
        return compact(
            {
                "deposit_memo": read_string(from_side.get("tag")) or fallback.get("deposit_memo"),
                "deposit_tx_id": read_nested_string(record, ("from", "tx", "id"))
                or fallback.get("deposit_tx_id"),
                "payout_tx_id": read_nested_string(record, ("to", "tx", "id"))
                or fallback.get("payout_tx_id"),
                "refund_tx_id": refund_tx_id,
                "attention": normalized_status.get("attention"),
                "attention_reason": normalized_status.get("attention_reason"),
                "refund_reason": refund_reason,
                "deposit_received_amount": self.read_decimal_amount(
                    read_nested_string(record, ("from", "tx", "amount")), "from.tx.amount"
                )
                or fallback.get("deposit_received_amount"),
                "refund_amount": self.read_decimal_amount(
                    read_nested_string(record, ("back", "amount")), "back.amount"
                )
                or fallback.get("refund_amount"),
                "emergency_repeat": fallback.get("emergency_repeat")
                if emergency_repeat is None
                else emergency_repeat,
                "fee": self.read_order_fee(record) or fallback.get("fee"),
            }
        )

    # ------------------------------------------------------- static helpers

    # The vector harness calls the interpreter through the provider, as Ruby
    # and C# do; the table itself lives in openreceive.swap.state.
    normalize_status = staticmethod(swap_state.normalize_status)

    @staticmethod
    def amount_msats_to_btc_string(amount_msats: object) -> str:
        if not isinstance(amount_msats, int) or isinstance(amount_msats, bool) or amount_msats <= 0:
            raise ValueError("invoice_amount_msats must be a positive safe integer.")
        sats = (amount_msats + 999) // 1000
        whole_btc = sats // 100_000_000
        fractional = str(sats % 100_000_000).rjust(8, "0").rstrip("0")
        return str(whole_btc) if not fractional else f"{whole_btc}.{fractional}"

    @staticmethod
    def format_api_error_message(path: str, status: int, msg: object) -> str:
        fixedfloat_message = read_string(msg)
        if fixedfloat_message is None:
            return f"FixedFloat {path} failed with HTTP {status}."
        return f"FixedFloat {path} failed with HTTP {status}: {fixedfloat_message}"

    @staticmethod
    def read_order_fee(record: dict[str, Any]) -> dict[str, Any] | None:
        pay_in_fiat = read_nested_string(record, ("from", "usd"))
        payout_fiat = read_nested_string(record, ("to", "usd"))
        if pay_in_fiat is None or payout_fiat is None:
            return None
        return {"currency": "USD", "pay_in_fiat": pay_in_fiat, "payout_fiat": payout_fiat}

    @staticmethod
    def read_decimal_amount(value: str | None, label: str) -> str | None:
        """Absent means absent; present-but-unparsable is a provider contract
        break and raises rather than dropping the amount from the order."""
        if value is None:
            return None
        if re.fullmatch(r"[0-9]+(\.[0-9]+)?", value) is None:
            raise FixedFloatProviderError(f"FixedFloat {label} is not a decimal amount.")
        return value

    @staticmethod
    def required_expires_at(expires_at: int | None) -> int:
        if expires_at is None:
            raise FixedFloatProviderError("FixedFloat order is missing time.expiration.")
        return int(expires_at)

    @staticmethod
    def persisted_status(fallback: dict[str, Any]) -> dict[str, Any]:
        return compact(
            {
                "state": fallback.get("state"),
                "attention": fallback.get("attention"),
                "attention_reason": fallback.get("attention_reason"),
                "refund_reason": fallback.get("refund_reason"),
            }
        )

    @staticmethod
    def read_currencies(data: Any) -> list[dict[str, Any]]:
        record = _as_record(data)
        if isinstance(data, list):
            items = data
        elif isinstance(record.get("ccies"), list):
            items = record["ccies"]
        elif isinstance(record.get("currencies"), list):
            items = record["currencies"]
        else:
            items = []
        currencies: list[dict[str, Any]] = []
        for item in items:
            row = _as_record(item)
            code = read_string(row.get("code")) or read_string(row.get("ticker"))
            coin = (
                read_string(row.get("coin"))
                or read_string(row.get("currency"))
                or read_string(row.get("symbol"))
            )
            network = (
                read_string(row.get("network"))
                or read_string(row.get("chain"))
                or read_string(row.get("networkName"))
                or read_string(row.get("name"))
            )
            if code is None or coin is None or network is None:
                continue
            currency: dict[str, Any] = {"code": code, "coin": coin.upper(), "network": network}
            if row.get("recv") in (True, False):
                currency["recv"] = row["recv"]
            if row.get("send") in (True, False):
                currency["send"] = row["send"]
            currencies.append(currency)
        return currencies

    @staticmethod
    def read_emergency_repeat(emergency: dict[str, Any]) -> bool | None:
        value = emergency.get("repeat")
        if value is True or value is False:
            return value
        if value in (0, "0"):
            return False
        if value in (1, "1"):
            return True
        return None

    @staticmethod
    def serialize_currency_resolution(resolution: dict[str, Any]) -> str:
        return json.dumps(
            {
                "fetched_at": resolution["fetched_at"],
                "pay_in": list(resolution["pay_in"].items()),
                "lightning": resolution["lightning"],
            }
        )

    @staticmethod
    def deserialize_currency_resolution(value: str) -> dict[str, Any]:
        parsed = json.loads(value)
        return {
            "fetched_at": parsed["fetched_at"],
            "pay_in": {str(key): item for key, item in parsed["pay_in"]},
            "lightning": parsed["lightning"],
        }

    @staticmethod
    def rate_pair_keys(resolution: dict[str, Any]) -> list[str]:
        lightning_code = resolution["lightning"]["code"]
        keys: list[str] = []
        for currency in resolution["pay_in"].values():
            key = rates_feed.pair_key(currency["code"], lightning_code)
            if key not in keys:
                keys.append(key)
        return keys


def _as_record(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def read_nested_string(value: object, path: tuple[str, ...]) -> str | None:
    current: object = value
    for key in path:
        current = _as_record(current).get(key)
    return read_string(current)


def read_string(value: object) -> str | None:
    if isinstance(value, str) and value:
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value == value and value not in (float("inf"), float("-inf")):
        return number_to_plain_decimal_string(value)
    return None


def number_to_plain_decimal_string(value: float | int) -> str:
    """Plain decimal notation, never exponent form (JS numberToPlainDecimalString)."""
    if isinstance(value, int):
        return str(value)
    text = format(Decimal(repr(value)), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text


def required_string(value: object, field: str) -> str:
    text = read_string(value)
    if text is None:
        raise FixedFloatProviderError(f"FixedFloat response missing {field}.")
    return text


def read_unix_seconds(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    numeric: Fraction | None
    if isinstance(value, str):
        try:
            numeric = Fraction(value.strip())
        except (ValueError, ZeroDivisionError):
            return None
    elif isinstance(value, int):
        numeric = Fraction(value)
    elif isinstance(value, float) and value == value and value not in (float("inf"), float("-inf")):
        numeric = Fraction(value)
    else:
        return None
    if numeric.denominator != 1 or numeric < 0 or numeric > rates_feed.MAX_SAFE_INTEGER:
        return None
    return int(numeric)
