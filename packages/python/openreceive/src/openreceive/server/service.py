"""The storage-agnostic receive checkout service: minting, the wallet-history
reconcile walk, swap quote/create/status/refund, and rates. Twin of Ruby
`OpenReceive::Server::Service`; the JS `createOpenReceive` is the secondary
reference. Framework-free and repository-free: `OpenReceiveApp` binds it to a
repository and a host.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections.abc import Callable, Mapping
from typing import Any, Protocol

from openreceive import money, settlement
from openreceive._generated.tables import NWC_METADATA_MAX_BYTES, TRANSACTION_PAGE_LIMIT
from openreceive.nwc import info as wallet_info
from openreceive.nwc.errors import normalize_wallet_error
from openreceive.nwc.requests import json_bytes, normalize_make_invoice_response
from openreceive.nwc.uri import NwcUriParseError
from openreceive.payments import scan
from openreceive.rates import (
    CachedPriceFeed,
    create_cached_live_price_feed,
    read_price_feed_url_overrides,
)
from openreceive.server.errors import (
    ConflictError,
    NotImplementedHttpError,
    ServiceError,
    SpendCapableWalletError,
    ValidationError,
    WalletContractError,
    WalletFailureError,
    WalletPreflightError,
)
from openreceive.swap import assets, providers_from_environment
from openreceive.swap.address import valid_for_pay_in_asset
from openreceive.swap.budget import SwapProviderWeightBudget
from openreceive.swap.cache import TransientSwapCache
from openreceive.values import LOWER_HEX_64_PATTERN, compact, stringify, to_int

PAGE_LIMIT = TRANSACTION_PAGE_LIMIT
MAX_PAGES = scan.MAX_PAGES
INVOICE_EXPIRY_SECONDS = 600
# Default shadow-invoice expiry when a swap provider does not report its own.
SWAP_INVOICE_EXPIRY_SECONDS = 600
# Maximum seconds the wallet's returned expiry may deviate from the requested
# expiry before checkout creation fails closed.
INVOICE_EXPIRY_TOLERANCE_SECONDS = 60
SPEND_METHODS = wallet_info.SPEND_METHODS

Clock = Callable[[], int]


class PriceProvider(Protocol):
    def btc_fiat_price(self, currency: str) -> str: ...


class Service:
    """`swap_providers=None` (the default) auto-builds FixedFloat-compatible
    providers from LSC_URI_PRIMARY / LSC_URI_BACKUP; pass a list (possibly
    empty) to override. `price_provider=None` uses the built-in cached live
    feed with OPENRECEIVE_PRICE_FEED_*_URL overrides; pass a provider, or
    `False` to run without rates (fiat amounts and GET /rates then fail with
    their not-configured errors). `logger` receives operator diagnostics that
    are logged, never sent."""

    def __init__(
        self,
        nwc_client: Any,
        *,
        price_provider: PriceProvider | bool | None = None,
        swap_providers: list[Any] | None = None,
        price_currencies: list[str] | None = None,
        clock: Clock | None = None,
        allow_spend_capable_wallet: bool = False,
        env: Mapping[str, str] | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        import os

        self._nwc = nwc_client
        self._clock: Clock = clock or (lambda: int(time.time()))
        self._env: Mapping[str, str] = os.environ if env is None else env
        self._logger = logger
        self.price_currencies = [str(value).upper() for value in (price_currencies or ["USD"])]
        if price_provider is False:
            self._price_provider: PriceProvider | None = None
        elif price_provider is None or price_provider is True:
            self._price_provider = self._default_price_provider()
        else:
            self._price_provider = price_provider
        self._swap_providers: list[Any] = (
            list(providers_from_environment(self._env, now=self._clock))
            if swap_providers is None
            else list(swap_providers)
        )
        self._attach_swap_provider_runtime()
        # The override relaxes only the spend refusal: receive-readiness and
        # encryption are still enforced.
        self._wallet_preflight(allow_spend_capable_wallet or self._spend_override_from_env())

    @property
    def nwc_client(self) -> Any:
        return self._nwc

    @property
    def swap_providers(self) -> list[Any]:
        return list(self._swap_providers)

    @property
    def price_provider(self) -> PriceProvider | None:
        return self._price_provider

    def now(self) -> int:
        return self._clock()

    # ------------------------------------------------------------- checkouts

    def prepare_checkout(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        with self._validating_input():
            data = stringify(payload)
            amount_msats, fiat_quote = self._resolve_amount(data["amount"])
        return {
            "amount_msats": amount_msats,
            "fiat_quote": fiat_quote,
            "payment_methods": self.list_swap_options(amount_msats),
        }

    def list_swap_options(self, amount_msats: object) -> list[dict[str, Any]]:
        """Amount-aware pay-in options: exactly one live provider's catalog —
        primary when healthy, otherwise the first backup that answers — over the
        full asset list with amount-vs-limit availability."""
        if not self._swap_providers:
            return []
        normalized_amount = self._normalize_swap_amount_msats(amount_msats)
        catalog = self._resolve_swap_provider_catalog()
        # Providers ARE configured, so an empty catalog means every one of them
        # failed its fetch — an outage, not a configuration gap.
        catalog_unreachable = not catalog
        return [
            self._swap_catalog_option(
                asset, normalized_amount, catalog.get(asset["pay_in_asset"]), catalog_unreachable
            )
            for asset in assets.list_info()
        ]

    def create_checkout(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        # Payer-input validation only: once the wallet has minted, a parse
        # failure is the wallet violating the receive contract, never a 400.
        with self._validating_input():
            data = stringify(payload)
            reference = self._required_string(data.get("reference"), "reference")
            amount_msats, fiat_quote = self._resolve_amount(data["amount"])
            # A caller-supplied expiry_seconds is a FLOOR (only the swap path
            # sets it); the library default is a request the wallet may clamp.
            required_expiry = data.get("expiry_seconds") is not None
            expiry = to_int(data.get("expiry_seconds") or INVOICE_EXPIRY_SECONDS)
            metadata = {**stringify(data.get("metadata") or {}), "reference": reference}
            if json_bytes(metadata) > NWC_METADATA_MAX_BYTES:
                raise ValidationError("metadata is too large for NIP-47.")
            request: dict[str, Any] = {
                "amount_msats": amount_msats,
                "expiry": expiry,
                "metadata": metadata,
            }
            if data.get("memo"):
                request["description"] = data["memo"]
            if data.get("description_hash"):
                request["description_hash"] = data["description_hash"]
        response = self._call_nwc("make_invoice", request)
        try:
            wallet = normalize_make_invoice_response(response)
            created_at = wallet.get("created_at") or self._clock()
            # The ledger row stores the wallet's OWN expires_at so reuse
            # buffering, reconciliation and the expiry+grace rule stay
            # consistent with the real invoice even when the wallet clamps.
            requested_expires_at = created_at + expiry
            expires_at = wallet.get("expires_at") or requested_expires_at
            shortfall = requested_expires_at - expires_at
            if abs(expires_at - requested_expires_at) > INVOICE_EXPIRY_TOLERANCE_SECONDS:
                if required_expiry and shortfall > INVOICE_EXPIRY_TOLERANCE_SECONDS:
                    self._log(
                        "error",
                        f"checkout.invoice_expiry.rejected: The wallet did not honor the required invoice expiry "
                        f"(required {expiry}s, got {expires_at - created_at}s). Use a wallet whose make_invoice honors expiry.",
                    )
                    raise WalletContractError(
                        "Error with the backing NWC wallet: it did not honor the requested invoice expiry."
                    )
                self._log(
                    "warning",
                    f"checkout.invoice_expiry.adjusted: The wallet clamped the requested invoice expiry "
                    f"(requested {expiry}s, got {expires_at - created_at}s); the wallet's own expiry is recorded on the attempt.",
                )
            return {
                "reference": reference,
                "payment_hash": wallet["payment_hash"],
                "bolt11": wallet["invoice"],
                "amount_msats": wallet["amount_msats"],
                "created_at": created_at,
                "expires_at": expires_at,
                "fiat_quote": fiat_quote,
            }
        except WalletContractError:
            raise
        except (KeyError, ValueError, TypeError):
            # Never blames the payer, and never puts the raw parse failure on the wire.
            raise WalletContractError()

    # ------------------------------------------------------------ reconcile

    def reconcile_payments(self, payload: Mapping[str, Any]) -> list[dict[str, Any]]:
        """One wallet-history pass over `attempts` ({payment_hash, created_at}):
        a settled walk, then an inclusive-unpaid walk for the misses, over one
        padded creation-time window. `max_pages` caps each walk and `deadline`
        is a monotonic instant checked between page fetches. A hash the walk
        could not decide is OMITTED (never not_found)."""
        data = stringify(payload)
        attempts = list(data.get("attempts") or [])
        if not attempts:
            return []
        expected: dict[str, int] = {}
        for attempt in attempts:
            row = stringify(attempt)
            expected[
                self._normalize_payment_hash(row.get("payment_hash", row.get("paymentHash")))
            ] = to_int(row.get("created_at", row.get("createdAt")))
        overlap = to_int(data.get("overlap_seconds", 60))
        if overlap < 0:
            raise ValueError("overlap_seconds must be a non-negative integer")
        scan_from = max(min(expected.values()) - overlap, 0)
        # Both window ends are padded: `from` against a wallet clock that lags,
        # `until` against one that runs ahead.
        scan_until = to_int(data.get("until") or (self._clock() + overlap))
        max_pages = data.get("max_pages")
        deadline = data.get("deadline")
        settled_scan = self._scan(list(expected), scan_from, scan_until, False, max_pages, deadline)
        by_hash = dict(settled_scan.rows)
        missing = [payment_hash for payment_hash in expected if payment_hash not in by_hash]
        truncated = False
        if missing:
            inclusive = self._scan(missing, scan_from, scan_until, True, max_pages, deadline)
            truncated = settled_scan.truncated or inclusive.truncated
            for payment_hash, row in inclusive.rows.items():
                by_hash.setdefault(payment_hash, row)
        results: list[dict[str, Any]] = []
        for payment_hash in expected:
            if payment_hash in by_hash:
                results.append(self._payment_result(payment_hash, by_hash[payment_hash]))
            elif not truncated:
                results.append({"payment_hash": payment_hash, "status": "not_found"})
        return results

    # ---------------------------------------------------------------- swaps

    def quote_swap(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        data = stringify(payload)
        asset = self._parse_pay_in_asset(data.get("pay_in_asset"))
        with self._validating_input():
            amount_msats, _ = self._resolve_amount(data["amount"])
        provider = self._select_provider(asset)
        quote = stringify(provider.quote(pay_in_asset=asset, invoice_amount_msats=amount_msats))
        return compact(
            {
                "provider": quote["provider"],
                "pay_asset": quote["pay_asset"],
                "available": quote["available"],
                "pay_amount": quote.get("pay_amount"),
                "minimum_pay_amount": quote.get("minimum_pay_amount"),
                "maximum_pay_amount": quote.get("maximum_pay_amount"),
                "minimum_invoice_amount_msats": quote.get("minimum_invoice_amount_msats"),
                "maximum_invoice_amount_msats": quote.get("maximum_invoice_amount_msats"),
                "unavailable_reason": quote.get("unavailable_reason"),
                "unavailable_message": quote.get("unavailable_message"),
            }
        )

    def create_swap(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        data = stringify(payload)
        asset = self._parse_pay_in_asset(data.get("pay_in_asset"))
        if "amount" not in data:
            raise ValidationError("amount")
        provider = self._select_provider(asset)
        expiry = (
            provider.invoice_expiry_seconds(pay_in_asset=asset)
            if hasattr(provider, "invoice_expiry_seconds")
            else SWAP_INVOICE_EXPIRY_SECONDS
        )
        # The shadow-invoice expiry is provider-mandated: the checkout input is
        # built from validated fields only, so no payer key can override it.
        checkout = self.create_checkout(
            {
                "reference": data.get("reference"),
                "amount": data["amount"],
                "memo": data.get("memo"),
                "metadata": data.get("metadata"),
                "expiry_seconds": expiry,
            }
        )
        order = stringify(
            provider.create_swap(
                pay_in_asset=asset,
                bolt11=checkout["bolt11"],
                invoice_amount_msats=checkout["amount_msats"],
            )
        )
        swap_data = {
            "version": 1,
            "provider_order": {key: value for key, value in order.items() if key != "raw"},
        }
        return {
            **self._public_swap(order, checkout["payment_hash"], checkout["reference"]),
            "checkout": checkout,
            "swap_data": swap_data,
        }

    def get_swap(
        self, *, reference: str, payment_hash: str, swap_data: Mapping[str, Any]
    ) -> dict[str, Any]:
        recovery = self._normalize_swap_data(swap_data)
        provider = self._provider_by_name(recovery["provider_order"]["provider"])
        try:
            current = stringify(provider.get_status(recovery["provider_order"]))
            return self._public_swap(
                current,
                self._normalize_payment_hash(payment_hash),
                self._required_string(reference, "reference"),
            )
        except KeyError as error:
            raise ValidationError(str(error))

    def refund_swap(
        self,
        *,
        reference: str,
        payment_hash: str,
        swap_data: Mapping[str, Any],
        refund_address: str,
    ) -> dict[str, Any]:
        recovery = self._normalize_swap_data(swap_data)
        payment_hash = self._normalize_payment_hash(payment_hash)
        host_reference = self._required_string(reference, "reference")
        address = self._normalize_refund_address(
            refund_address, recovery["provider_order"].get("pay_in_asset")
        )
        provider = self._provider_by_name(recovery["provider_order"]["provider"])
        current = stringify(provider.get_status(recovery["provider_order"]))
        if current.get("state") != "refund_required":
            raise ConflictError(
                f"Swap cannot be refunded from provider state {current.get('state')}."
            )
        provider.request_refund(current, address)
        return self.get_swap(
            reference=host_reference, payment_hash=payment_hash, swap_data=recovery
        )

    # ---------------------------------------------------------------- rates

    def list_rates(self, payload: Mapping[str, Any] | None = None) -> dict[str, Any]:
        if self._price_provider is None:
            raise NotImplementedHttpError("No price provider is configured for rates.")
        data = stringify(payload or {})
        currencies = [
            str(value).strip().upper()
            for value in (data.get("currencies") or self.price_currencies)
        ]
        for currency in currencies:
            if re.fullmatch(r"[A-Z]{3}", currency) is None:
                raise ValidationError(f"Invalid currencies entry: {currency}.")
            if currency not in self.price_currencies:
                raise ValidationError(
                    "fiat.currency must be one of the configured priceCurrencies: "
                    + ", ".join(self.price_currencies)
                    + "."
                )
        return {
            "bitcoin": {
                currency.lower(): self._btc_fiat_price_or_unavailable(currency)
                for currency in currencies
            }
        }

    # ------------------------------------------------------------ internals

    def _btc_fiat_price_or_unavailable(self, currency: str) -> str:
        """EVERY feed-side failure maps to the payer-facing retryable 503: the
        feed being unable to price a configured currency is an outage."""
        assert self._price_provider is not None
        try:
            return str(self._price_provider.btc_fiat_price(currency))
        except ServiceError:
            raise
        except Exception:
            raise ServiceError(
                503,
                "INTERNAL",
                "Exchange rates are temporarily unavailable — please try again in a moment.",
                retryable=True,
            )

    def _wallet_preflight(self, allow_spend_capable: bool) -> None:
        """Fail-closed boot preflight: a connection that can report capabilities
        must be receive-ready and speak an encryption mode we implement, and —
        unless the host overrides — must not advertise spend methods. A read
        failure is NOT transient: booting blind only defers it to the first
        customer checkout."""
        raw_info = self._read_wallet_info()
        if raw_info is None:
            return  # No info method at all: nothing to preflight.
        summary = wallet_info.summarize(raw_info)
        if not summary["receive_checkout_ready"]:
            raise WalletPreflightError(
                "the wallet does not advertise make_invoice and list_transactions."
            )
        if summary["encryption"] is None:
            raise WalletPreflightError(
                "the wallet supports no encryption mode OpenReceive speaks (NIP-04 or NIP-44 v2)."
            )
        if allow_spend_capable:
            return
        spend = [method for method in summary["methods"] if method in SPEND_METHODS]
        if spend:
            raise SpendCapableWalletError(spend)

    def _read_wallet_info(self) -> Any:
        reader = next(
            (
                getattr(self._nwc, name)
                for name in ("preflight", "get_info", "get_wallet_service_info")
                if hasattr(self._nwc, name)
            ),
            None,
        )
        if reader is None:
            return None
        try:
            return reader()
        except NwcUriParseError:
            raise
        except Exception as error:
            raise WalletPreflightError(
                f"could not read wallet info ({type(error).__name__}: {error})."
            )

    def _spend_override_from_env(self) -> bool:
        raw = (self._env.get("OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC") or "").strip().lower()
        if not raw:
            return False
        if raw in ("1", "true", "yes"):
            return True
        if raw not in ("0", "false", "no"):
            self._log(
                "warning",
                f"Unrecognized OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC value {raw!r}; treating it as disabled. Use 1/true/yes to enable.",
            )
        return False

    def _default_price_provider(self) -> CachedPriceFeed:
        overrides = read_price_feed_url_overrides(self._env)
        return create_cached_live_price_feed(
            currencies=self.price_currencies,
            clock=self._clock,
            primary_url=overrides["primary_url"],
            fallback_url=overrides["fallback_url"],
        )

    def _attach_swap_provider_runtime(self) -> None:
        """One shared transient cache and one per-provider weight budget,
        attached to every provider that supports them."""
        if not self._swap_providers:
            return
        cache = TransientSwapCache(self._clock)
        for provider in self._swap_providers:
            if hasattr(provider, "attach_swap_cache"):
                provider.attach_swap_cache(cache)
            if hasattr(provider, "attach_weight_budget"):
                provider.attach_weight_budget(SwapProviderWeightBudget(provider.name, self._clock))

    def _resolve_swap_provider_catalog(self) -> dict[str, dict[str, Any]]:
        """Exactly one live provider's catalog: primary when healthy, otherwise
        the first backup that answers. Never merge catalogs."""
        for provider in self._swap_providers:
            try:
                if hasattr(provider, "pay_in_asset_catalog"):
                    catalog = list(provider.pay_in_asset_catalog())
                else:
                    catalog = [
                        {"pay_asset": str(asset)} for asset in provider.supported_pay_in_assets()
                    ]
            except Exception:
                continue  # Catalog/rates feed down for this provider — try the next.
            return {
                str(stringify(item)["pay_asset"]): {**stringify(item), "provider": provider.name}
                for item in catalog
            }
        return {}

    @staticmethod
    def _swap_catalog_option(
        asset: dict[str, Any],
        amount_msats: int,
        provider_asset: dict[str, Any] | None,
        catalog_unreachable: bool,
    ) -> dict[str, Any]:
        if provider_asset is None:
            reason, message = (
                ("provider_unreachable", "The swap provider is temporarily unreachable.")
                if catalog_unreachable
                else ("provider_unconfigured", "Automated swaps are not configured for this asset.")
            )
            return {
                "pay_in_asset": asset["pay_in_asset"],
                "label": asset["label"],
                "network_label": asset["network_label"],
                "provider": "",
                "available": False,
                "unavailable_reason": reason,
                "unavailable_message": message,
            }
        minimum_msats = provider_asset.get("minimum_invoice_amount_msats")
        maximum_msats = provider_asset.get("maximum_invoice_amount_msats")
        limit_reason = None
        if amount_msats > 0 and minimum_msats is not None and amount_msats < minimum_msats:
            limit_reason = "amount_too_small"
        elif amount_msats > 0 and maximum_msats is not None and amount_msats > maximum_msats:
            limit_reason = "amount_too_large"
        unavailable = provider_asset.get("available") is False
        unavailable_reason = limit_reason or (
            provider_asset.get("unavailable_reason") if unavailable else None
        )
        if limit_reason == "amount_too_small":
            unavailable_message: str | None = "This invoice is below the provider minimum."
        elif limit_reason == "amount_too_large":
            unavailable_message = "This invoice is above the provider maximum."
        else:
            unavailable_message = provider_asset.get("unavailable_message") if unavailable else None
        option: dict[str, Any] = {
            "pay_in_asset": asset["pay_in_asset"],
            "label": asset["label"],
            "network_label": asset["network_label"],
            "provider": provider_asset["provider"],
            "available": unavailable_reason is None and not unavailable,
        }
        if unavailable_reason is not None:
            option["unavailable_reason"] = unavailable_reason
        if unavailable_message is not None:
            option["unavailable_message"] = unavailable_message
        for key in ("minimum_pay_amount", "maximum_pay_amount"):
            if provider_asset.get(key) is not None:
                option[key] = provider_asset[key]
        if minimum_msats is not None:
            option["minimum_invoice_amount_msats"] = minimum_msats
        if maximum_msats is not None:
            option["maximum_invoice_amount_msats"] = maximum_msats
        return option

    def _resolve_amount(self, payload: object) -> tuple[int, dict[str, Any] | None]:
        amount = stringify(payload)
        if "sats" in amount:
            return money.direct_to_msats("SATS", amount["sats"]), None
        currency = self._required_string(amount.get("currency"), "amount.currency").upper()
        value = self._required_string(amount.get("value"), "amount.value")
        if currency in ("BTC", "SAT", "SATS"):
            return money.direct_to_msats(currency, value), None
        if self._price_provider is None:
            raise ValidationError("price provider is not configured")
        if currency not in self.price_currencies:
            raise ValidationError(
                "fiat.currency must be one of the configured priceCurrencies: "
                + ", ".join(self.price_currencies)
                + "."
            )
        price = self._btc_fiat_price_or_unavailable(currency)
        msats = money.quote_fiat_to_msats(value, price)
        return msats, {
            "fiat": {"currency": currency, "value": value},
            "btc_fiat_price": price,
            "amount_msats": msats,
            "as_of": self._clock(),
        }

    def _payment_result(self, payment_hash: str, transaction: dict[str, Any]) -> dict[str, Any]:
        status = settlement.status(transaction)
        observed_at = self._clock()
        details: dict[str, Any] = {"transaction": transaction, "observed_at": observed_at}
        result: dict[str, Any] = {"payment_hash": payment_hash, "status": status}
        if status == "settled":
            result["paid_at"] = transaction.get("settled_at") or observed_at
            details["paid_at_source"] = (
                "settled_at" if transaction.get("settled_at") else "observed_at"
            )
        result["details"] = details
        return result

    def _scan(
        self,
        expected: list[str],
        scan_from: int,
        scan_until: int,
        unpaid: bool,
        max_pages: object,
        deadline: object,
    ) -> scan.ScanResult:
        return scan.list_incoming_transactions(
            _ScanClient(self, None if deadline is None else float(str(deadline))),
            expected,
            scan_from=scan_from,
            scan_until=scan_until,
            max_pages=MAX_PAGES if max_pages is None else to_int(max_pages),
            include_unpaid=unpaid,
        )

    def _call_nwc(self, method: str, params: dict[str, Any]) -> Any:
        try:
            return getattr(self._nwc, method)(params)
        except ServiceError:
            raise
        except Exception as error:
            raise WalletFailureError(normalize_wallet_error(error)) from error

    def _select_provider(self, asset: str) -> Any:
        """Primary-only while healthy; backup only when primary raises, never to
        fill gaps for assets the primary simply does not list."""
        for provider in self._swap_providers:
            try:
                supported = list(provider.supported_pay_in_assets())
            except ServiceError:
                raise
            except Exception:
                continue
            if asset in supported:
                return provider
            raise self._unsupported_swap_asset_error(asset)
        raise self._unsupported_swap_asset_error(asset)

    @staticmethod
    def _unsupported_swap_asset_error(asset: str) -> ServiceError:
        return ServiceError(503, "INTERNAL", f"No configured swap provider supports {asset}.")

    def _provider_by_name(self, name: object) -> Any:
        for provider in self._swap_providers:
            if provider.name == name:
                return provider
        raise ServiceError(503, "INTERNAL", f"Swap provider {name} is not configured.")

    @staticmethod
    def _public_swap(order: dict[str, Any], payment_hash: str, reference: str) -> dict[str, Any]:
        # Everything the payer may see; `provider_token` stays server-only.
        return compact(
            {
                "payment_hash": payment_hash,
                "reference": reference,
                "provider": order["provider"],
                "pay_in_asset": order["pay_in_asset"],
                "deposit_address": order["deposit_address"],
                "deposit_memo": order.get("deposit_memo"),
                "deposit_amount": order["deposit_amount"],
                "provider_state": order["state"],
                "provider_expires_at": order["expires_at"],
                "deposit_tx_id": order.get("deposit_tx_id"),
                "payout_tx_id": order.get("payout_tx_id"),
                "refund_tx_id": order.get("refund_tx_id"),
                "refund_reason": order.get("refund_reason"),
                "refund_amount": order.get("refund_amount"),
                "attention": order.get("attention"),
                "attention_reason": order.get("attention_reason"),
                "deposit_received_amount": order.get("deposit_received_amount"),
                "emergency_repeat": order.get("emergency_repeat"),
                "provider_order_id": order.get("provider_order_id"),
                "fee": order.get("fee"),
            }
        )

    @staticmethod
    def _normalize_swap_data(value: object) -> dict[str, Any]:
        data = stringify(value)
        order = data.get("provider_order")
        if not (
            data.get("version") == 1
            and isinstance(order, dict)
            and str(order.get("provider") or "")
            and str(order.get("provider_order_id") or "")
        ):
            raise ValidationError("swapData is invalid.")
        return data

    @staticmethod
    def _parse_pay_in_asset(value: object) -> str:
        if not assets.is_pay_in_asset(value):
            raise ValidationError("payInAsset is not supported.")
        return str(value)

    @staticmethod
    def _normalize_swap_amount_msats(value: object) -> int:
        """Lightning invoices are whole sats; round up so catalog limits match create."""
        try:
            amount = to_int(value)
        except (ValueError, TypeError):
            amount = None
        if amount is None or amount < 1000:
            raise ValidationError("amountMsats must be an integer >= 1000.")
        return ((amount + 999) // 1000) * 1000

    @staticmethod
    def _normalize_refund_address(value: object, pay_in_asset: object) -> str:
        """A refund is the last chance to recover a mis-sent deposit: checked
        against the order's own pay-in network with its checksum."""
        normalized = str(value if value is not None else "").strip()
        if not normalized or len(normalized) > 300:
            raise ValidationError("refundAddress is invalid.")
        if isinstance(pay_in_asset, str) and not valid_for_pay_in_asset(pay_in_asset, normalized):
            raise ValidationError(f"refundAddress is not a valid {pay_in_asset} address.")
        return normalized

    @staticmethod
    def _required_string(value: object, field: str) -> str:
        text = str(value if value is not None else "").strip()
        if not text:
            raise ValidationError(f"{field} is required.")
        return text

    @classmethod
    def _normalize_payment_hash(cls, value: object) -> str:
        payment_hash = cls._required_string(value, "payment_hash").lower()
        if LOWER_HEX_64_PATTERN.match(payment_hash) is None:
            raise ValidationError("payment_hash must be 64 hexadecimal characters")
        return payment_hash

    @staticmethod
    def _validating_input() -> _ValidatingInput:
        return _ValidatingInput()

    def _log(self, level: str, message: str) -> None:
        if self._logger is not None:
            getattr(self._logger, level)(message)


class _ValidatingInput:
    """The payer-input parse boundary: a missing field (KeyError) or a malformed
    one (ValueError/TypeError) inside the block is a 400, not a 500. Wallet and
    provider calls stay outside it."""

    def __enter__(self) -> None:
        return None

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, _tb: object
    ) -> None:
        if exc is None or isinstance(exc, ServiceError):
            return None
        if isinstance(exc, (KeyError, ValueError, TypeError)):
            message = exc.args[0] if isinstance(exc, KeyError) and exc.args else str(exc)
            raise ValidationError(str(message)) from exc
        return None


class _ScanClient:
    """Adapts the service's wallet call to the core walk and enforces the
    request-path deadline between page fetches: once the monotonic deadline
    passes, the previous page is replayed — the walk recognizes the repeat and
    ends marked truncated, so a deadline-cut walk can never prove an invoice absent."""

    def __init__(self, service: Service, deadline: float | None) -> None:
        self._service = service
        self._deadline = deadline
        self._previous: Any = None

    def list_transactions(self, params: dict[str, Any]) -> Any:
        if (
            self._previous is not None
            and self._deadline is not None
            and time.monotonic() >= self._deadline
        ):
            return self._previous
        self._previous = self._service._call_nwc("list_transactions", params)
        return self._previous


def redact_secrets(text: str) -> str:
    """Failure text can embed wallet credentials (an NWC URI inside a connect
    error); redact them before the message reaches a host log."""
    text = re.sub(r"nostr\+walletconnect:[^\s\"'`<>]+", "[REDACTED_NWC]", text)
    return re.sub(r"lightning\+swapconnect:[^\s\"'`<>]+", "[REDACTED_LSC]", text)


def sanitize_failure_message(error: BaseException) -> str:
    return redact_secrets(f"{type(error).__name__}: {error}")


def dumps(value: object) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
