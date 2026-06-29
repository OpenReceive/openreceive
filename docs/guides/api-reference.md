# API Reference

OpenReceive is a server-side SDK, not a route bundle. Your app owns its
controllers, sessions, CSRF/CORS policy, response status codes, and payload
shape. OpenReceive supplies functions that those controllers can call.

App-facing packages:

- `@openreceive/node`: `createOpenReceive(options)` returns a server-only
  service with `createCheckout`, `getOrder`, `getCheckout`, `listRates`,
  `quoteRates`, and `close`.
- `@openreceive/browser`: `requestCheckout`, `status`, `lightningUri`,
  `qrSvg`, `qrPngDataUrl`, `copyInvoice`, `openWallet`, and
  `createCheckoutController`.
- `@openreceive/react`: `Checkout`, `useCheckout`, `CheckoutProvider`,
  `ThemeScope`, `ThemeToggle`, `QRCode`, `CopyInvoiceButton`,
  `OpenWalletButton`, `InvoiceSummary`, `WaitingState`, and `PaymentWizard`.
- `@openreceive/elements`: `defineOpenReceiveElements` and the checkout/theme
  custom elements.

Framework-adapter internals live under `@openreceive/browser/internal` and are
not part of the supported app surface.

## `createCheckout`

Create or continue one immutable priced checkout under your app's `order_id`:

```ts
const checkout = await openreceive.createCheckout({
  order_id: order.uuid,
  amount: {
    fiat: {
      currency: order.total_amount.currency,
      value: order.total_amount.value
    }
  },
  memo: `Order ${order.number}`,
  expires_in_seconds: 600,
  metadata: {
    cart_version: order.cart_version
  }
});
```

Use exactly one amount source:

- `{ fiat: { currency: "USD", value: "0.10" } }`
- `{ btc: { currency: "BTC", value: "0.005" } }`
- `{ sats: "7000" }`
- `{ msats: "7000000" }`

`fiat.currency` must be one of the server's configured `priceCurrencies`.
Direct BTC, satoshi, and millisatoshi amounts do not use price feeds.

Calling `createCheckout` again with the same `order_id` and same amount returns
the current checkout, or renews its BOLT11 when the active invoice has expired.
Calling it with the same `order_id` and a different amount creates a new
checkout and supersedes the prior open checkout. Paying any invoice in any
checkout settles the order.

Render `checkout.active.invoice` when present. The full invoice chain is in
`checkout.invoices`.

## `getOrder`

Refresh and read the stored order:

```ts
const orderStatus = await openreceive.getOrder({ order_id: order.uuid });
```

`getOrder` may perform one bounded server-side NWC `list_transactions` scan for
unpaid, wallet-unexpired invoice records. It never exposes send-payment methods
and never uses invoice lookup as the settlement authority.

Fulfillment belongs in your backend settlement hook. When an order is paid,
fulfill from `orderStatus.paid_checkout`, not from the current cart. For UI
display, use `orderStatus.display_checkout`.

## `getCheckout`

Read one checkout by `checkout_id` when your app already knows that the caller is
allowed to see it:

```ts
const checkout = await openreceive.getCheckout({ checkout_id });
```

Most app controllers only need `createCheckout` and `getOrder`.

## Rates

```ts
const rates = await openreceive.listRates();
const quote = await openreceive.quoteRates({
  fiat: { currency: "USD", value: "0.10" }
});
```

`quote.amount_msats` is the exact millisatoshi quote used by checkout-created
invoices.

## Errors

Service errors are `OpenReceiveServiceError` instances:

```ts
import { OpenReceiveServiceError } from "@openreceive/node";

try {
  const checkout = await openreceive.createCheckout(input);
  return { checkout };
} catch (error) {
  if (error instanceof OpenReceiveServiceError) {
    return { error: error.body, status: error.status };
  }
  throw error;
}
```

Your framework decides how that `{ error, status }` becomes an HTTP response.
