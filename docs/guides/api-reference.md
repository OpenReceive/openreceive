# API Reference

OpenReceive supplies backend service methods for your own checkout controllers.
Most apps call these methods from routes like `/create_order` and
`/order_status`. The `/openreceive/v1` paths below are lower-level reference
HTTP shapes for adapters that intentionally expose OpenReceive-flavored routes.
The source of truth for the example HTTP payloads is
`spec/openapi/openreceive-http.v1.yaml`.

App-facing packages:

- `@openreceive/node`: `createOpenReceive(options)` returns a server-only
  service with `createInvoice`, `getInvoice`, `refreshInvoiceStatus`,
  `refreshInvoice`, `listRates`, `quoteRates`, and `close`.
- `@openreceive/browser`: `requestCheckoutInvoice`, `status`,
  `lightningUri`, `qrSvg`, `qrPngDataUrl`, `copyInvoice`, `openWallet`, and
  `createCheckoutController`.
- `@openreceive/react`: `Checkout`, `useCheckout`, `CheckoutProvider`,
  `ThemeScope`, `ThemeToggle`, `QRCode`, `CopyInvoiceButton`,
  `OpenWalletButton`, `InvoiceSummary`, `WaitingState`, and `PaymentWizard`.
- `@openreceive/elements`: `defineOpenReceiveElements` and the checkout/theme
  custom elements.

Framework-adapter internals live under `@openreceive/browser/internal` and are
not part of the supported app surface.

## Create Invoice

App-facing Node service input uses camelCase:

```ts
await openreceive.createInvoice({
  orderId: order.uuid,
  amount: {
    fiat: {
      currency: order.totalAmount.currency,
      value: order.totalAmount.value
    }
  },
  memo: `Order ${order.number}`,
  expiresInSeconds: 600
});
```

`fiat.currency` must be one of the server's configured `priceCurrencies`; the
currency is an order property, not a browser-locale guess.

For Bitcoin-denominated orders, use direct amount units instead of `fiat`:

```ts
await openreceive.createInvoice({
  orderId: order.uuid,
  amount: {
    btc: {
      currency: "BTC",
      value: "0.005"
    }
  },
  memo: `Order ${order.number}`,
  expiresInSeconds: 600
});

await openreceive.createInvoice({
  orderId: order.uuid,
  amount: {
    sats: "7000"
  },
  memo: `Order ${order.number}`,
  expiresInSeconds: 600
});
```

Direct BTC and satoshi amounts are converted directly to `amount_msats`; they
are not looked up in the configured price feeds.

`POST /openreceive/v1/invoices`

Lower-level HTTP request body includes:

- `order_uuid`: stable app order/cart/payment-attempt id. Replays the same
  create request and conflicts on drift.

Use exactly one amount input:

- `amount`: direct Bitcoin units, for example
  `{ "currency": "BTC", "value": "0.005" }` or
  `{ "currency": "SATS", "value": "7000" }`.
- `amount_sats`: integer satoshis from `1` through `9007199254740`.
- `amount_msats`: integer from `1000` through `9007199254740991`.
- `fiat`: `{ "currency": "USD", "value": "0.10" }` style decimal string.

Optional HTTP wire fields include `optional_invoice_description`,
`description_hash`, and `expiry`. In the Node SDK, `memo` maps to
`optional_invoice_description` and `expiresInSeconds` maps to `expiry`. The
memo becomes the BOLT11 invoice description and is limited to 500 characters.

Responses:

- `201`: new invoice.
- `200`: idempotent replay of the same request.
- `409`: same idempotency scope with a different request body.

## Read Invoice

`GET /openreceive/v1/invoices/{invoice_id}`

Use this route from whatever controller, middleware, or route group already
protects the owning checkout session when invoice reads should not be public.

## Refresh Invoice Status

`POST /openreceive/v1/invoices/{invoice_id}/status`

This route performs one bounded backend status refresh for the stored invoice.
It uses NWC `list_transactions` server-side and returns the stored state. Use
your app's route protection when status should not be public.

The response may include `wallet_scan_performed` and `transactions_checked`.
App fulfillment still belongs in the backend settlement hook. A preimage alone
is not settlement proof.

## Refresh Invoice

`POST /openreceive/v1/invoices/{invoice_id}/refresh`

App-facing Node service input:

- `idempotencyKey`: stable for the refresh operation.

If your app exposes this as an HTTP route, a common controller pattern is to
read `Idempotency-Key` and pass it to `openreceive.refreshInvoice()` as
`idempotencyKey`. Refresh creates a linked replacement invoice after expiry or
failure. It never mutates the old invoice in place. Settled invoices return
`409`.

## Rates

`GET /openreceive/v1/rates`

Returns the configured BTC fiat rate map.

`POST /openreceive/v1/rates/quote`

```json
{
  "fiat": {
    "currency": "USD",
    "value": "0.10"
  }
}
```

Returns the same rate quote shape used by invoice creation, including
`amount_msats`, source id, `as_of`, and `expires_at`.

## Provider Data

Provider and route suggestions belong to `@openreceive/provider-data` and the
browser UI packages. They are static payer guidance, not Node receive routes,
settlement proof, or availability guarantees.

## Error Shape

Errors use the shared error schema:

```json
{
  "code": "INVALID_REQUEST",
  "message": "Human-readable error",
  "retryable": false
}
```

Adapters may include `retryable`, `request_id`, or `details` when that context
is available. Render a defensive fallback message when an app sees an
unfamiliar detail shape.
