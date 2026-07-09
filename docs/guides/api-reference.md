# API Reference

OpenReceive ships HTTP routes you can mount (see [Shipped Routes](routes.md)), and
also exposes service methods for hosts that call them from their own controllers.
Your app still owns sessions, CSRF/CORS, and fulfillment. Amounts on the
**HTTP** create-checkout body are never trusted — use the required `resolveOrder`
hook there. Amounts passed to `getOrCreateCheckout` below are trusted because they
come from your server.

App-facing packages:

- `openreceive` / `@openreceive/node`: `createOpenReceive(options)` returns a
  server-only service with `getOrCreateCheckout`, `createCheckout`, `getOrder`,
  `getCheckout`, `order`, `swapOptions`, `swapQuote`, `startSwap`, `refundSwap`,
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
SDK inputs are camelCase; OpenReceive checkout and order payloads remain
snake_case so your controllers can return them over HTTP:

```ts
const checkout = await openreceive.getOrCreateCheckout({
  orderId: order.uuid,
  usd: order.total_amount.value,
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

Use exactly one amount source. The common shortcuts are:

- `usd: "9.99"`
- `sats: 1000`

The explicit form is still available:

- `{ fiat: { currency: "USD", value: "0.10" } }`
- `{ btc: { currency: "BTC", value: "0.005" } }`

`fiat.currency` must be one of the server's configured `priceCurrencies`.
Direct bitcoin amounts do not use price feeds. If your product is denominated
in sats, use the `btc` amount object with `currency: "SATS"`.

`getOrCreateCheckout` has idempotent order semantics:

- If the order is already paid, it returns the paid checkout and does not mint a
  new invoice.
- If the order has an unexpired open checkout for the same amount, it returns
  that checkout.
- If the prior checkout expired and the amount is unchanged, a user-driven retry
  mints a fresh checkout and BOLT11.
- If the amount changes, it supersedes the prior open checkout and creates a new
  checkout for the new amount.

`createCheckout` remains as an alias for existing integrations, but
`getOrCreateCheckout` names the behavior more directly. Paying any invoice in
any checkout settles the order.

Render `checkout.active.invoice` when present. The full invoice chain is in
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

`createCheckout` schedules its sweep as best-effort background work. On a
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

Most apps only need the single typed router `openreceive.order(body)`; its return
type narrows on the request's `action`:

```ts
const status = await openreceive.order({ order_id: order.uuid });
// -> OpenReceiveOrderStatus: order fields + swaps_enabled + swap_pay_options

const { quote } = await openreceive.order({
  order_id: order.uuid,
  action: "swap_quote",
  pay_in_asset: "USDT_TRON"
});

const { attempt } = await openreceive.order({
  order_id: order.uuid,
  action: "start_swap",
  pay_in_asset: "USDT_TRON"
});
```

The four lower-level methods stay available as escape hatches for custom UIs
(camelCase SDK inputs). `startSwap` and `refundSwap` return a first-class
`OpenReceiveSwapAttempt` — deposit fields top-level, shadow invoice under
`shadow_invoice`:

```ts
const options = await openreceive.swapOptions({ orderId: order.uuid });
const quote = await openreceive.swapQuote({ orderId: order.uuid, payInAsset: "USDT_TRON" });

const attempt = await openreceive.startSwap({ orderId: order.uuid, payInAsset: "USDT_TRON" });
attempt.deposit_address; // no optional `.swap` to unwrap

await openreceive.refundSwap({
  attemptId: attempt.attempt_id,
  refundAddress: "...",
  refundNonce: attempt.refund_nonce,
  confirm: false // stage
});

await openreceive.refundSwap({
  attemptId: attempt.attempt_id,
  refundAddress: "...",
  refundNonce: attempt.refund_nonce,
  confirm: true // dispatch
});
```

Refunds target `attemptId`, not order id plus asset. Public swap payloads expose
support fields such as `attempt_id`, `provider_order_id`, transaction ids,
`provider_state`, `attention_reason`, and `refund_nonce_expires_at`. Refunds require
the current `refund_nonce` and an explicit confirmation call from an
application-authorized order context. Provider tokens remain private.

Classify a `provider_state` for display with the exported helpers:

```ts
import { describeSwapState, OPENRECEIVE_SWAP_STATES } from "@openreceive/node";

const { label, detail, phase, terminal } = describeSwapState(attempt.provider_state);
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
