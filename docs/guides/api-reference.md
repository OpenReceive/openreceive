# API Reference

OpenReceive supplies backend service methods for your own checkout controllers.
Most apps call these methods from routes like `/create_order` and
`/order_status`. The `/openreceive/v1` paths below are lower-level reference
HTTP shapes for adapters that intentionally expose OpenReceive-flavored routes.
The source of truth for the example HTTP payloads is
`spec/openapi/openreceive-http.v1.yaml`.

App-facing packages:

- `@openreceive/node`: `createOpenReceive(options)` returns a server-only
  service with `createCheckout`, `getOrder`, `getCheckout`, `listRates`,
  `quoteRates`, and `close`.
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

## Create Checkout

App-facing Node service input uses camelCase:

```ts
await openreceive.createCheckout({
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
await openreceive.createCheckout({
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

await openreceive.createCheckout({
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

`POST /openreceive/v1/orders/{order_id}/checkouts`

Lower-level HTTP request body includes:

- `order_id`: optional redundant copy of the path id for browser helpers and
  app-owned controllers that prefer body-based routing.

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

- `201`: a new checkout, superseding checkout, or renewed invoice chain.
- `200`: the current active checkout for the same order id and amount.

Reusing the same `orderId` with a different amount creates a new checkout and
supersedes the previous open checkout. Paying any invoice from any checkout for
that order marks the order paid.

## Read Checkout

`GET /openreceive/v1/checkouts/{checkout_id}`

Use this route from whatever controller, middleware, or route group already
protects the owning checkout session when checkout reads should not be public.

## Refresh Order Status

`POST /openreceive/v1/orders/{order_id}/status`

This route performs one bounded backend status refresh for the stored order.
It uses NWC `list_transactions` server-side and returns the stored state. Use
your app's route protection when status should not be public.

The response may include `wallet_scan_performed` and `transactions_checked`.
App fulfillment still belongs in the backend settlement hook. A preimage alone
is not settlement proof.

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

Returns the same rate quote shape used by checkout-created invoices, including
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
