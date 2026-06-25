# API Reference

OpenReceive supplies backend service methods for your own checkout controllers.
Most apps call these methods from routes like `/create_order` and
`/order_status`. The `/openreceive/v1` paths below are lower-level reference
HTTP shapes for adapters that intentionally expose OpenReceive-flavored routes.
The source of truth for the example HTTP payloads is
`spec/openapi/openreceive-http.v1.yaml`.

App-facing packages:

- `@openreceive/node`: `createOpenReceive(options)` returns a server-only
  service with `createInvoice`, `getInvoice`, `lookupInvoice`,
  `refreshInvoice`, `listRates`, `quoteRates`, `poll`, and `close`.
- `@openreceive/browser`: `createInvoice`, `status`, `lightningUri`, `qrSvg`,
  `qrPngDataUrl`, `copyInvoice`, `openWallet`, and
  `createCheckoutController`.
- `@openreceive/react`: `Checkout`, `useCheckout`, `CheckoutProvider`,
  `ThemeScope`, `ThemeToggle`, `QRCode`, `CopyInvoiceButton`,
  `OpenWalletButton`, `InvoiceSummary`, `WaitingState`, and `PaymentWizard`.
- `@openreceive/elements`: `defineOpenReceiveElements` and the checkout/theme
  custom elements.

Framework-adapter internals live under `@openreceive/browser/internal` and are
not part of the supported app surface.

## Create Invoice

`POST /openreceive/v1/invoices`

Request body includes:

- `order_uuid`: stable app order/cart/payment-attempt id. Replays the same
  create request and conflicts on drift.

Use exactly one amount input:

- `amount_sats`: integer satoshis from `1` through `9007199254740`.
- `amount_msats`: integer from `1000` through `9007199254740991`.
- `fiat`: `{ "currency": "USD", "value": "0.10" }` style decimal string.

Optional fields include `optional_invoice_description` and `expiry`.
`optional_invoice_description` becomes the BOLT11 invoice description and is
limited to 500 characters.

Responses:

- `201`: new invoice.
- `200`: idempotent replay of the same request.
- `409`: same idempotency scope with a different request body.

## Read Invoice

`GET /openreceive/v1/invoices/{invoice_id}`

Use this route from whatever controller, middleware, or route group already
protects the owning checkout session when invoice reads should not be public.

## Lookup Invoice

`POST /openreceive/v1/invoices/lookup`

Body contains either `payment_hash` or `invoice`. This route performs backend
payment verification. Use your app's route protection when status should not be
public.

The lookup response may include proof details, but app fulfillment still belongs
in the server `onPaid` hook. A preimage alone is not settlement proof.

## Refresh Invoice

`POST /openreceive/v1/invoices/{invoice_id}/refresh`

Service input:

- `idempotency_key`: stable for the refresh operation.

If your app exposes this as an HTTP route, a common controller pattern is to
read `Idempotency-Key` and pass it to `openreceive.refreshInvoice()` as
`idempotency_key`. Refresh creates a linked replacement invoice after expiry or
failure. It never mutates the old invoice in place. Settled invoices return
`409`.

## Poll

`openreceive poll --once`

Runs one scheduled recovery job from a server-side scheduler. The Node package
does not provide a public poll route handler.

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
