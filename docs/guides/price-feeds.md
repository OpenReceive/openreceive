# Price Feeds

OpenReceive converts fiat amounts to sats at invoice creation time, then locks
the quote on the invoice. The wallet still receives `amount_msats`; fiat values
are only a quoting input.

`createOpenReceive()` defaults to a live cached price feed. It reads rates from
two hard-coded Simple Price endpoints — a primary and a fallback — and caches
the result in the OpenReceive database. Internal tests and deterministic
fixtures can pass an explicit `StaticPriceProvider`.

## Supported Shape

Both live endpoints return the same Simple Price compatible JSON:

```json
{
  "bitcoin": {
    "usd": 59616,
    "eur": "52263"
  }
}
```

Numbers and decimal strings are accepted. OpenReceive converts the selected BTC
fiat price to a decimal string before final quote math and does not use binary
floating point for fiat-to-sat conversion.

## Live Feed: Primary, Fallback, and the 60-Second Cache

A live server resolves rates through a database-cached feed instead of calling
an exchange on every order. The flow on each rate read is:

1. **Read the cache.** OpenReceive keeps the most recent rate map as JSON in the
   database, together with the time it was fetched. If that row is younger than
   **60 seconds**, the cached rates are used and no network call is made. This is
   what stops repeated orders from each hitting an exchange.
2. **Refresh from the primary URL.** If the cached row is missing or stale,
   OpenReceive fetches the **primary** feed. If it does not respond within
   **5 seconds**, the request is aborted.
3. **Refresh from the fallback URL.** If the primary timed out or returned an
   invalid response, OpenReceive fetches the **fallback** feed.
4. **Write the cache.** Whichever feed answered, its full rate map and the fetch
   time are written back to the database so the next read inside the window is a
   cache hit.

The two endpoints are hard-coded:

- Primary:
  `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,aed,…,zar`
- Fallback:
  `https://openreceive.org/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,aed,…,zar`

Both request the same fixed fiat list. A developer can override either URL with
an environment variable:

- `OPENRECEIVE_PRICE_FEED_PRIMARY_URL`
- `OPENRECEIVE_PRICE_FEED_FALLBACK_URL`

An override must still serve the Simple Price shape above.

### Boot-Time Health Check

When a server configured with the live feed boots, OpenReceive probes the feed
once (primary, then fallback). **If neither the primary nor the fallback URL
responds with a valid BTC fiat rate map, `createOpenReceive` throws and the
server refuses to boot.** The probe also warms the cache. Explicit static test
providers are not health-checked.

A refresh keeps every well-formed currency the response carries and skips any
single currency an upstream returns unusably, so one dropped currency does not
fail the feed or block boot — only an order in that specific currency fails,
until the next refresh.

### Cache Storage

The cache is a single JSON row in the OpenReceive store's meta table under the
key `price_feed:bitcoin`. It records the rate map (`rates`), which feed produced
it (`source`, either `primary` or `fallback`), and the Unix-seconds fetch time
(`fetched_at`). Because it lives in the same durable store as invoices
(SQLite or Postgres in production), the 60-second window is shared across every
worker that uses the same store and namespace.

## Source Order

The canonical source order is:

1. `static_mock`
2. `primary`
3. `fallback`

`spec/data/rates/price-sources.json` records the canonical source ids, the
60-second cache window, the 5000ms primary timeout, the quote TTL, and the
endpoint URLs.

## Wiring It Up

`@openreceive/node` exposes `createOpenReceivePriceFeed({ store, currencies })`,
which builds the database-cached primary/fallback feed (applying any env-var URL
overrides) and is then passed to `createOpenReceive`:

```ts
import { createOpenReceive, createOpenReceivePriceFeed } from "@openreceive/node";

const priceCurrencies = ["USD", "EUR"];
const priceProviders = [createOpenReceivePriceFeed({ store, currencies: priceCurrencies })];

const openreceive = await createOpenReceive({
  nwc,
  store,
  priceProviders,
  priceCurrencies
});
```

Use `@openreceive/core`'s `StaticPriceProvider` only when an internal runtime
should stay deterministic and offline, such as repository tests or screenshots.
It serves static fixture rates and is never boot-probed. Public demos use a real
receive-only NWC code and the cached live feed.

`@openreceive/core` also exposes the lower-level pieces:
`createCachedLivePriceFeed` (the same feed without env reads),
`createLivePriceFeedProviders` (just the two `HttpSimplePriceProvider`
instances), and `getBtcFiatRatesWithFallback` (try a list of providers in
order). Invoice creation quotes internally from the configured `priceProviders`.

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
- `source` on a quote is `static_mock`, `primary`, or `fallback`.

Use `quoteFiatToMsatsWithPrice` when a live adapter supplied the BTC fiat price.
Use `quoteFiatToMsats` for deterministic fixture-rate conversions.
Use `quoteFiatToMsatsWithProvider` when a backend adapter wants the quote to
carry the source id from the provider that supplied the rate.
