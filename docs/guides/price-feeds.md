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

- Fiat `amount.value` is a decimal string; amounts round up to a whole sat.
- `amount_msats` is `amount_sats * 1000`. Public payloads use `amount_msats`.
- Quotes expire after `invoice_quote_ttl_seconds`. Minimum invoice is one sat.
- Override feed URLs only if needed: `OPENRECEIVE_PRICE_FEED_PRIMARY_URL` /
  `OPENRECEIVE_PRICE_FEED_FALLBACK_URL` (must still serve Simple Price JSON).

Cache behavior, source order, and quote math internals are documented in
[Architecture](../internal/architecture.md) § Price feed cache.
