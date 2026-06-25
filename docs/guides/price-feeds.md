# Price Feeds

OpenReceive converts fiat amounts to sats at invoice creation time, then locks
the quote on the invoice. The wallet still receives `amount_msats`; fiat values
are only a quoting input.

The static provider is the default for tests, docs, screenshots, and
deterministic fixtures. Live adapters and the JS Hello Fruit demos use
CoinGecko Simple Price compatible JSON.

## Supported Shape

The live rate response shape is:

```json
{
  "bitcoin": {
    "usd": 62599,
    "eur": "54792.12"
  }
}
```

Numbers and decimal strings are accepted. OpenReceive converts the selected BTC
fiat price to a decimal string before final quote math and does not use binary
floating point for fiat-to-sat conversion.

## Source Order

The default source order is:

1. `static_mock`
2. `openreceive_mirror`
3. `megalithic_mirror`
4. `coingecko_direct`

`spec/data/rates/price-sources.json` records the canonical source ids, cache
seconds, quote TTL, and endpoint URLs.

`@openreceive/core` exposes the same order through
`createDefaultPriceProviders()`. Use `createDefaultLivePriceProviders()` when a
runtime should skip the deterministic static mock and try the OpenReceive
mirror, Megalithic mirror, then CoinGecko direct.

Apps can expose their own rate or quote endpoints when their UI needs a quote
before checkout. Invoice creation can also quote internally from the configured
`priceProviders`; the JS Hello Fruit demos wire
`createDefaultLivePriceProviders({ currencies: ["USD"] })` for live demos and
use the deterministic static provider only in fake-wallet tests.

The same currency list is the invoice-creation allowlist. A backend that calls
`createOpenReceive({ priceProviders, priceCurrencies: ["USD", "EUR"] })` may
create fiat invoices only for those explicit uppercase currency codes. The
browser can localize display however it wants, but the server must pass the
actual order currency in `fiat.currency`.

`BTC`, `SAT`, and `SATS` are not fiat price-feed currencies. For
Bitcoin-denominated products, pass `amount: { currency: "BTC", value: "0.005" }`
or `amount: { currency: "SATS", value: "7000" }` to `createInvoice`. Those
amounts convert directly to `amount_msats` and never call a price provider.

## Quote Rules

- `fiat.currency` is an uppercase allowlisted currency code.
- `fiat.value` is a decimal string.
- `btc_fiat_price` is stored as a decimal string.
- Amounts round up to a whole sat.
- `amount_msats` is `amount_sats * 1000`.
- Quotes expire after `invoice_quote_ttl_seconds`.
- The minimum invoice amount is one sat, or `1000` msats.

Use `quoteFiatToMsatsWithPrice` when a live adapter supplied the BTC fiat price.
Use `quoteFiatToMsats` for the deterministic static mock.
Use `quoteFiatToMsatsWithProvider` when a backend adapter wants the quote to
carry the source id from the provider that supplied the rate.
