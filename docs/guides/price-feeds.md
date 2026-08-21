# Price Feeds

OpenReceive converts fiat amounts to sats at invoice creation time, then locks
the quote on the invoice. The wallet still receives `amount_msats`; fiat values
are only a quoting input.

## Default wiring

`createOpenReceive()` builds a live cached primary/fallback feed for you:

```ts
import { createOpenReceive } from "@openreceive/node";

const openreceive = await createOpenReceive({
  priceCurrencies: ["USD", "EUR"]
});

console.log(openreceive.priceCurrencies); // ["USD", "EUR"]
```

If `priceCurrencies` is omitted, OpenReceive falls back to `["USD"]`. Keep this
non-secret allowlist in the host's normal Node configuration module or Rails
initializer.

The same currency list is the checkout-creation allowlist. Pass the actual order
currency in `amount.currency` (uppercase). For Bitcoin-denominated products, use
`amount: { currency: "BTC", value: "0.005" }` or `amount: { sats: 7000 }` —
those convert directly to `amount_msats` and never call a price provider.

## What you need to know

- Pricing fails closed: when no sufficiently recent rate is available (feeds
  down, or the newest observation is older than the quote TTL), fiat-priced
  checkout creation is refused with a retryable 503 ("Exchange rates are
  temporarily unavailable…") instead of minting a mispriced invoice. There is
  no implicit mock rate; tests and offline dev opt in explicitly with
  `priceProviders: [new StaticPriceProvider()]`.
- Fiat `amount.value` is a decimal string; amounts round up to a whole sat.
- `amount_msats` is `amount_sats * 1000`. Public payloads use `amount_msats`.
- Quotes expire after the fixed spec constant `invoice_quote_ttl_seconds`
  (600s — not a host knob). Minimum invoice is one sat.
- Override feed URLs only if needed: `OPENRECEIVE_PRICE_FEED_PRIMARY_URL` /
  `OPENRECEIVE_PRICE_FEED_FALLBACK_URL` (must still serve Simple Price JSON).

Cache behavior: reads are served from a 60-second process-local cache; a
refresh tries the primary feed (5s timeout) then the fallback (10s timeout —
both abort rather than inheriting the runtime's multi-minute default); entries
older than the 600-second quote TTL are never used to price an invoice, and a
cache window longer than that TTL is rejected at construction. Concurrent
callers on a cold cache join the one in-flight refresh instead of failing. The
cache is an optimization only — no payment truth depends on it.
