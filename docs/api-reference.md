# API Reference

OpenReceive mounts backend routes inside your application, usually at
`/openreceive/v1`. The source of truth for HTTP payloads is
`spec/openapi/openreceive-http.v1.yaml`.

App-facing packages:

- `@openreceive/node`: `createOpenReceive(options)` returns an object with
  `mountExpress(app)`, `handleFetch(request)`, `handleNode(req, res)`,
  `runtime`, and `close()`.
- `@openreceive/browser`: `createInvoice`, `status`, `lightningUri`, `qrSvg`,
  `qrPngDataUrl`, `copyInvoice`, `openWallet`, and
  `createCheckoutController`.
- `@openreceive/react`: `Checkout`, `useCheckout`, `CheckoutProvider`,
  `ThemeScope`, `QRCode`, `CopyInvoiceButton`, `OpenWalletButton`, and
  `InvoiceSummary`.
- `@openreceive/elements`: `defineOpenReceiveElements` and the checkout/theme
  custom elements.

Framework-adapter internals live under `@openreceive/browser/internal`.

## Create Invoice

`POST /openreceive/v1/invoices`

Required header:

- `Idempotency-Key`: stable for your configured OpenReceive scope and create
  operation.

Request body uses exactly one amount input:

- `amount_msats`: integer from `1000` through `9007199254740991`.
- `fiat`: `{ "currency": "USD", "value": "0.10" }` style decimal string.

Optional fields include `description`, `description_hash`, `expiry`, and
`metadata`. Exactly one of `description` or `description_hash` may be present.

Responses:

- `201`: new invoice.
- `200`: idempotent replay of the same request.
- `409`: same idempotency scope with a different request body.

## Read Invoice

`GET /openreceive/v1/invoices/{invoice_id}`

Authorize this route against the owning order, cart, checkout session, or user
with `authorize.invoice`.

## Lookup Invoice

`POST /openreceive/v1/invoices/lookup`

Body contains either `payment_hash` or `invoice`. This route performs backend
wallet verification. Protect it with `authorize.invoice`; lookup can reveal
payment status.

The lookup response may include proof details, but app fulfillment still belongs
in the server `onPaid` hook. A preimage alone is not settlement proof.

## Refresh Invoice

`POST /openreceive/v1/invoices/{invoice_id}/refresh`

Required header:

- `Idempotency-Key`: stable for your configured OpenReceive scope and refresh
  operation.

Refresh creates a linked replacement invoice after expiry or failure. It never
mutates the old invoice in place. Settled invoices return `409`.

## Poll

`POST /openreceive/v1/poll`

Runs one bounded recovery pass through the OpenReceive store. Protect it with
`authorize.scheduler` or `OPENRECEIVE_CRON_SECRET`. This route is optional and
is not a long-running worker.

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

## Provider Routes

`GET /openreceive/v1/routes`

Returns the static route catalog for the payment wizard.

`GET /openreceive/v1/providers`

Returns runtime provider registry entries and metadata, including local
`icon_path` values.

Provider routes are suggestions, not settlement proof or availability
guarantees. Backend wallet lookup remains the payment authority.

## Health And Capabilities

`GET /openreceive/v1/health` returns `{ "ok": true }` when the adapter is
mounted.

`GET /openreceive/v1/capabilities` returns a non-secret capability summary.
Wallet secrets, raw NWC connection strings, and private wallet diagnostics stay
out of this response.

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
