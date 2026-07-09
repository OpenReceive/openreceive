# API Reference

OpenReceive ships HTTP routes you can mount (see [Shipped Routes](routes.md)), and
also exposes service methods for hosts that call them from their own controllers.
Your app still owns sessions, CSRF/CORS, and fulfillment. Amounts on the
**HTTP** create-checkout body are never trusted — use the required `getCheckoutAmount`
hook there. Amounts passed to `getOrCreateCheckout` below are trusted because they
come from your server.

App-facing packages:

- `openreceive` / `@openreceive/node`: `createOpenReceive(options)` returns a
  server-only service with `getOrCreateCheckout`, `getOrder`, `getCheckout`,
  `swapOptions`, `swapQuote`, `startSwap`, `refundSwap`,
  `sweepPendingInvoices`, `listRates`, `quoteRates`, and `close`, plus
  `startSweeper`, the resolved `namespace` and `priceCurrencies`, and the
  swap-state helpers `describeSwapState` / `OPENRECEIVE_SWAP_STATES`.
- `openreceive/express` | `fastify` | `next` (optional peers): mount the shipped
  routes with `createOpenReceive` + the adapter in one import.
- `@openreceive/browser`: `requestCheckout`, `status`, `lightningUri`,
  `qrSvg`, `qrPngDataUrl`, `copyInvoice`, `openWallet`, and
  `createCheckoutController`.
- `@openreceive/react` (also `openreceive/react`): `Checkout`, `useCheckout`,
  `CheckoutProvider`, `ThemeScope`, `ThemeToggle`, `QRCode`, `CopyInvoiceButton`,
  `OpenWalletButton`, `InvoiceSummary`, `WaitingState`, and `PaymentWizard`.
- `@openreceive/elements`: `defineOpenReceiveElements` and the checkout/theme
  custom elements.

Framework-adapter internals live under `@openreceive/browser/internal` and are
not part of the supported app surface.

## `getOrCreateCheckout`

Create, reuse, or renew one immutable priced checkout under your app's order id.
The JS SDK is camelCase end-to-end (`amountMsats`, `checkoutId`,
`displayCheckout`). The HTTP/OpenAPI layer still serializes snake_case at the
wire boundary.

```ts
const checkout = await openreceive.getOrCreateCheckout({
  orderId: order.uuid,
  amount: { currency: "USD", value: order.total_amount.value },
  memo: `Order ${order.number}`,
  // Optional app-owned JSON. OpenReceive stores and returns it to your
  // settlement hook without interpreting non-reserved keys.
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

`getOrCreateCheckout` has idempotent order semantics:

- If the order is already paid, it returns the paid checkout and does not mint a
  new invoice.
- If the order has an unexpired open checkout for the same amount, it returns
  that checkout.
- If the prior checkout expired and the amount is unchanged, a user-driven retry
  mints a fresh checkout and BOLT11.
- If the amount changes, it supersedes the prior open checkout and creates a new
  checkout for the new amount.

Paying any invoice in any checkout settles the order.

Render `checkout.active.bolt11` when present. The full invoice chain is in
`checkout.invoices`.

## `getOrder`

Refresh and read the stored order:

```ts
const orderStatus = await openreceive.getOrder({ orderId: order.uuid });
```

`getOrder` may advance one bounded global NWC `list_transactions` sweep for all
open invoices, then returns the requested order from storage. It never creates
replacement invoices, never exposes send-payment methods, and never uses invoice
lookup as the settlement authority.

Fulfillment belongs in your backend settlement hook. When an order is paid,
fulfill from `orderStatus.paid_checkout`, not from the current cart. For UI
display, use `orderStatus.display_checkout`.

## `getCheckout`

Read one checkout by `checkout_id` when your app already knows that the caller is
allowed to see it:

```ts
const checkout = await openreceive.getCheckout({ checkoutId });
```

Most app controllers only need `getOrCreateCheckout` and `getOrder`.

## `sweepPendingInvoices`

Run one explicit global settlement sweep:

```ts
await openreceive.sweepPendingInvoices();
```

Organic checkout creation and `getOrder` traffic already drive sweeps. Use this
optional method from a cron, worker, or interval when you want settlement latency
that does not depend on user traffic.

`getOrCreateCheckout` schedules its sweep as best-effort background work. On a
long-lived Node server, fire-and-forget is fine. In serverless handlers, pass a
platform `waitUntil(promise)` hook to `createOpenReceive` so the platform can
keep that sweep alive. `getOrder` awaits its sweep and remains the reliable
polling backbone.

## Rates

```ts
const rates = await openreceive.listRates();
const quote = await openreceive.quoteRates({
  fiat: { currency: "USD", value: "0.10" }
});
const configuredFiatCurrencies = openreceive.priceCurrencies;
```

`quote.amount_msats` is the exact millisatoshi quote used by checkout-created
invoices.

## Automated Swaps

Automated swaps are optional and auto-load providers from a backend YAML config
with secret env references. See [Automated Swaps](automated-swaps.md) for setup,
the payer flow, the state lifecycle, and offline testing.

Call the typed camelCase service methods directly. HTTP `POST /orders/:id` still
accepts a snake_case body with `action` and composes status for you; the SDK does
not expose a parallel `order()` router.

```ts
const order = await openreceive.getOrder({ orderId: order.uuid });
const swap = await openreceive.swapOptions({ orderId: order.uuid });
const status = {
  ...order,
  swapsEnabled: swap.enabled,
  swapPayOptions: swap.enabled ? swap.options : [],
};

const quote = await openreceive.swapQuote({
  orderId: order.uuid,
  payInAsset: "USDT_TRON",
});

const attempt = await openreceive.startSwap({
  orderId: order.uuid,
  payInAsset: "USDT_TRON",
});
```

`startSwap` and `refundSwap` return a first-class `SwapAttempt` — deposit fields
top-level, shadow invoice under `shadowInvoice`:

```ts
const options = await openreceive.swapOptions({ orderId: order.uuid });
const quote = await openreceive.swapQuote({ orderId: order.uuid, payInAsset: "USDT_TRON" });

const attempt = await openreceive.startSwap({ orderId: order.uuid, payInAsset: "USDT_TRON" });
attempt.depositAddress; // no optional `.swap` to unwrap

await openreceive.refundSwap({
  attemptId: attempt.attemptId,
  refundAddress: "...",
  refundNonce: attempt.refundNonce,
  confirm: false // stage
});

await openreceive.refundSwap({
  attemptId: attempt.attemptId,
  refundAddress: "...",
  refundNonce: attempt.refundNonce,
  confirm: true // dispatch
});
```

Refunds target `attemptId`, not order id plus asset. Public swap payloads expose
support fields such as `attemptId`, `providerOrderId`, transaction ids,
`providerState`, `attentionReason`, and `refundNonceExpiresAt`. Refunds require
the current `refundNonce` and an explicit confirmation call from an
application-authorized order context. Provider tokens remain private. HTTP wire
payloads stay snake_case (`attempt_id`, `provider_state`, …).

Classify a `providerState` for display with the exported helpers:

```ts
import { describeSwapState, OPENRECEIVE_SWAP_STATES } from "@openreceive/node";

const { label, detail, phase, terminal } = describeSwapState(attempt.providerState);
```

## Errors

Service errors are `OpenReceiveServiceError` instances:

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
