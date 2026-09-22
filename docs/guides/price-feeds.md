# Price Feeds

OpenReceive converts fiat amounts to sats when it creates an invoice, and then
locks that quote on the invoice. The wallet still receives `amount_msats`. Fiat
values are only used to work out the quote.

## Default wiring

`createOpenReceive()` builds a live, cached price feed with a primary and a
fallback source:

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  priceCurrencies: ["USD", "EUR"]
});

console.log(openreceive.priceCurrencies); // ["USD", "EUR"]
```

If you omit `priceCurrencies`, OpenReceive uses `["USD"]`. This list is not
secret. Keep it in your normal Node configuration module or Rails initializer.

The primary feed is CoinGecko's public Simple Price endpoint
(`api.coingecko.com`). The fallback is the OpenReceive mirror at
`openreceive.org`, which returns the same response shape. A refresh only
contacts the fallback when the primary fails or times out. Any process that
quotes fiat amounts needs outbound HTTPS to both hosts.

The same currency list controls which currencies checkout creation accepts.
Pass the order's real currency in `amount.currency`, in uppercase. For products
priced in Bitcoin, use `amount: { currency: "BTC", value: "0.005" }` or
`amount: { sats: 7000 }`. Those convert directly to `amount_msats` and never
call a price provider.

## What you need to know

- Pricing fails closed. This means OpenReceive refuses rather than guesses. If
  no recent enough rate is available, fiat-priced checkout creation is refused
  with a retryable 503 ("Exchange rates are temporarily unavailable…"). That
  happens when the feeds are down, or when the newest rate is older than the
  quote TTL. OpenReceive does this so it never creates a mispriced invoice.
- There is no hidden mock rate. Tests and offline development must opt in with
  `priceProviders: [new StaticPriceProvider()]`.
- Fiat `amount.value` is a decimal string. Amounts round up to a whole sat.
- `amount_msats` is `amount_sats * 1000`. Public payloads use `amount_msats`.
- Quotes expire after `invoice_quote_ttl_seconds`, which is 600s. It is a fixed
  spec constant, not a setting you can change. The minimum invoice is one sat.
- Override the feed URLs only if you need to, with
  `OPENRECEIVE_PRICE_FEED_PRIMARY_URL` and
  `OPENRECEIVE_PRICE_FEED_FALLBACK_URL`. The replacement must still serve
  Simple Price JSON.

Each process caches rates briefly. A stale or missing rate fails closed instead
of creating a mispriced invoice. The cache only makes things faster. No payment
record depends on it.
