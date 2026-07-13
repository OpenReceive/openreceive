# API Reference

Prefer mounting OpenReceive (see the [Node](quickstart-node.md) /
[Rails](quickstart-rails.md) quickstarts and [Authorization](authorization.md)).
This page lists the service methods and app-facing packages. Amounts on the
public create-checkout HTTP body are never trusted — use the required
`prepareCheckout` hook on POST `/prepare`. Amounts passed to
`getOrCreateCheckout` are trusted because they come from your server.

Calling service methods from your own controllers:
[Custom Controller Integration](../internal/custom-controller-integration.md).

## Packages

- `openreceive` / `@openreceive/node`: `createOpenReceive(options)` returns a
  server-only service with `getOrCreateCheckout`, `getOrder`, `getCheckout`,
  `swapOptions`, `swapQuote`, `startSwap`, `refundSwap`,
  `sweepPendingInvoices`, `listRates`, `quoteRates`, and `close`, plus
  `startSweeper`, the resolved `namespace` and `priceCurrencies`, and the
  swap-state helpers `describeSwapState` / `OPENRECEIVE_SWAP_STATES`.
- `openreceive/express` | `fastify` | `next` (optional peers): mount the shipped
  routes with `createOpenReceive` + the adapter in one import.
- `@openreceive/browser`: `requestPrepare`, `requestOrderSummary`,
  `requestCheckout`, `status`, `lightningUri`, `qrSvg`, `qrPngDataUrl`,
  `copyInvoice`, `openWallet`, and `createCheckoutController`.
- `@openreceive/react` (also `openreceive/react`): `Checkout`, `useCheckout`,
  `CheckoutProvider`, `ThemeScope`, `ThemeToggle`, `QRCode`, `CopyInvoiceButton`,
  `OpenWalletButton`, `InvoiceSummary`, `WaitingState`, and `PaymentWizard`.
- `@openreceive/elements`: `defineOpenReceiveElements` and the checkout/theme
  custom elements.

Framework-adapter internals live under `@openreceive/browser/internal` and are
not part of the supported app surface.

## `getOrCreateCheckout`

Create, reuse, or renew one immutable priced checkout under your app's order id.
The JS SDK is camelCase (`amountMsats`, `checkoutId`, `displayCheckout`). The
HTTP/OpenAPI layer serializes snake_case at the wire boundary.

```ts
const checkout = await openreceive.getOrCreateCheckout({
  orderId: order.uuid,
  amount: { currency: "USD", value: order.total_amount.value },
  memo: `Order ${order.number}`,
  metadata: {
    app_context: {
      fulfillment: "digital",
      internal_order_number: order.number
    }
  }
});
```

Amount is always nested under `amount`, with exactly one shape:

- `{ amount: { currency: "USD", value: "9.99" } }` — fiat (ISO 4217) or `BTC`/`SAT`/`SATS`
- `{ amount: { sats: 1000 } }` — integer sats shortcut

`amount.currency` for fiat must be one of the server's configured
`priceCurrencies`. Direct bitcoin amounts do not use price feeds.

Idempotent order semantics:

- Order already paid → returns the paid checkout (no new invoice).
- Same amount, unexpired open checkout → returns that checkout.
- Prior checkout expired, amount unchanged → user-driven retry mints a fresh checkout.
- Amount changed → supersedes the prior open checkout and creates a new one.

Paying any invoice in any checkout settles the order. Render
`checkout.active.bolt11` when present. The full invoice chain is in
`checkout.invoices`.

## `getOrder`

```ts
const orderStatus = await openreceive.getOrder({ orderId: order.uuid });
```

`getOrder` may advance one bounded global NWC `list_transactions` sweep, then
returns the requested order from storage. It never creates replacement invoices.
Fulfill from `orderStatus.paid_checkout`, not from the current cart. For UI
display, use `orderStatus.display_checkout`.

## `getCheckout`

```ts
const checkout = await openreceive.getCheckout({ checkoutId });
```

Most app controllers only need `getOrCreateCheckout` and `getOrder`.

## `sweepPendingInvoices`

```ts
await openreceive.sweepPendingInvoices();
```

Organic checkout creation and `getOrder` traffic already drive sweeps. Use this
from a cron, worker, or interval when you want settlement latency that does not
depend on user traffic. Details:
[Settlement Sweeps](../internal/settlement-sweeps.md).

## Rates

```ts
const rates = await openreceive.listRates();
const quote = await openreceive.quoteRates({
  fiat: { currency: "USD", value: "0.10" }
});
const configuredFiatCurrencies = openreceive.priceCurrencies;
```

`quote.amount_msats` is the exact millisatoshi quote used by checkout-created
invoices. See [Price Feeds](price-feeds.md).

## Automated swaps

Optional; auto-load providers from backend YAML. Setup and payer flow:
[Automated Swaps](automated-swaps.md). Operator lifecycle and attention runbook:
[Swap Operations](../internal/swap-operations.md).

```ts
const swap = await openreceive.swapOptions({ orderId: order.uuid });
const attempt = await openreceive.startSwap({
  orderId: order.uuid,
  payInAsset: "USDT_TRON",
});
attempt.depositAddress;
attempt.providerState; // feed to describeSwapState()
```

Refunds target `attemptId` and require the current `refundNonce` plus explicit
confirmation. Provider tokens remain private.

## Errors

```ts
import { OpenReceiveServiceError } from "@openreceive/node";

try {
  const checkout = await openreceive.getOrCreateCheckout(input);
  return { checkout };
} catch (error) {
  if (error instanceof OpenReceiveServiceError) {
    return { error: error.body, status: error.status };
  }
  throw error;
}
```

Your framework decides how that `{ error, status }` becomes an HTTP response.
