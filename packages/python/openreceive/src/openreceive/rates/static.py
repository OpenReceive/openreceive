"""The fixed static_mock table (BTC/USD 50000.00) — the one price fixture
every engine's testkit shares: a $1.00 button is 2,000 sats."""

from __future__ import annotations

from typing import Any

from openreceive import rates


class StaticPriceProvider:
    source = rates.STATIC_PRICE_SOURCE_ID

    def btc_fiat_rates(self, currencies: list[str]) -> dict[str, Any]:
        return {
            "bitcoin": {
                rates.normalize_fiat_currency(currency): rates.static_btc_fiat_price(currency)
                for currency in currencies
            }
        }

    def btc_fiat_rates_with_source(self, currencies: list[str]) -> dict[str, Any]:
        return {"source": self.source, "rates": self.btc_fiat_rates(currencies)}

    def btc_fiat_price(self, currency: str) -> str:
        return rates.static_btc_fiat_price(currency)
