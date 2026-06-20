# Price Feeds

OpenReceive converts fiat amounts to sats at invoice creation time, then locks
the quote on the invoice. The wallet still receives `amount_msats`; fiat values
are only a quoting input.

The static provider is the default for tests, docs, screenshots, and
deterministic demos. Live adapters may use CoinGecko Simple Price compatible
JSON.

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

The planned source order is:

1. `static_mock`
2. `openreceive_mirror`
3. `megalithic_mirror`
4. `coingecko_direct`

`spec/data/rates/price-sources.json` records the canonical source ids, cache
seconds, quote TTL, and endpoint URLs.

The Express adapter exposes deterministic v0.1 helper routes at
`GET /openreceive/v1/rates` and `POST /openreceive/v1/rates/quote`. These routes
use the static mock source unless the host app wires a later live provider.

## Quote Rules

- `fiat.value` is a decimal string.
- `btc_fiat_price` is stored as a decimal string.
- Amounts round up to a whole sat.
- `amount_msats` is `amount_sats * 1000`.
- Quotes expire after `invoice_quote_ttl_seconds`.
- The minimum invoice amount is one sat, or `1000` msats.

Use `quoteFiatToMsatsWithPrice` when a live adapter supplied the BTC fiat price.
Use `quoteFiatToMsats` for the deterministic static mock.
