# API Reference

OpenReceive does not require a daemon. Framework adapters mount these routes
inside the merchant application, usually at `/openreceive/v1`. The authoritative
HTTP contract is `spec/openapi/openreceive-http.v1.yaml`.

The HTTP routes are not the whole backend integration. Server packages also
provide a settlement polling runner and a payment notification listener.
Polling uses backend `lookup_invoice`; trusted `payment_received`
notifications may settle the matching invoice directly. If no notification
arrives, polling remains the recovery and settlement fallback.

Server packages also provide OpenReceive-owned persistence for invoice,
idempotency, lifecycle, and settlement-action rows inside the host app
database. The host app attaches app-owned hooks after settlement instead of
designing these tables itself.

Invoice, lookup, and event responses return `Cache-Control: no-store`. Browser
responses never contain an NWC connection string or client secret.

## Create Invoice

`POST /openreceive/v1/invoices`

Required header:

- `Idempotency-Key`: stable per merchant scope and create-invoice operation.

Request body uses exactly one amount input:

- `amount_msats`: integer from `1000` through `9007199254740991`.
- `fiat`: `{ "currency": "USD", "value": "0.10" }` style decimal string.

Optional fields include `description`, `description_hash`, `expiry`, and
`metadata`. Exactly one of `description` or `description_hash` may be present.
Metadata must fit the NWC payload guard.

Responses:

- `201`: new invoice.
- `200`: idempotent replay of the same request.
- `409`: same idempotency scope with a different request body.

## Read Invoice

`GET /openreceive/v1/invoices/{invoice_id}`

The invoice id is application-scoped and matches `or_inv_[a-z0-9_]+`.
Adapters must authorize this route against the owning order, cart, checkout
session, or user.

## Lookup Invoice

`POST /openreceive/v1/invoices/lookup`

Body contains either `payment_hash` or `invoice`. This route performs backend
wallet verification and must not be exposed as a public status oracle. Access
must be strongly authorized to the matching invoice.

The lookup response may include `preimage_present`, but app actions still
require settled state from backend wallet verification. A preimage alone is not
settlement proof. If the host app configured a backend settlement action hook, a
settled lookup may return `workflow_state: "settlement_action_completed"`,
`settlement_action_state: "completed"`, and `settlement_action_completed_at`
after that hook completes.
If no hook is configured, adapters may complete the settlement action boundary
as a no-op after backend settlement is proven.

## Refresh Invoice

`POST /openreceive/v1/invoices/{invoice_id}/refresh`

Required header:

- `Idempotency-Key`: stable per merchant scope and refresh operation.

The body may include `{ "reason": "expired" }`. Refresh creates a new invoice
row linked to the old row through `refreshed_from_invoice_id`; it never mutates
the old invoice in place. Settled invoices return `409`.

Responses:

- `201`: linked replacement invoice created.
- `200`: idempotent replay of the same refresh request.
- `409`: invoice is not refreshable.

## Invoice Events

`GET /openreceive/v1/invoices/{invoice_id}/events`

The v0.1 reference adapter uses Server-Sent Events. Clients may send
`Last-Event-ID` for replay. Event streams are passive UI hints; they do not
run merchant settlement actions.

When the Express adapter is configured with signed event URLs,
`checkout.events_url` includes a short-lived `_or_evt` query value scoped to the
invoice. Do not log or persist the full URL.

The authoritative event contract is
`spec/asyncapi/openreceive-events.v1.yaml`.

Event names:

- `invoice.created`
- `invoice.verifying`
- `invoice.settled`
- `invoice.expired`
- `invoice.failed`
- `invoice.settlement_action_completed`
- `invoice.cancelled`

## Rates

`GET /openreceive/v1/rates`

Returns the configured BTC fiat rate map. The default open-source adapter uses
`static_mock` data so docs, tests, and screenshots are stable. Apps can provide
live price providers; the JS Hello Fruit demos do this for USD prices.

`POST /openreceive/v1/rates/quote`

Body:

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

Returns the static route catalog: supported assets, crypto routes, fiat rails,
and countries. Supplying query parameters such as `asset=btc`,
`country=US&rail=bank`, or `route=btc-lightning` returns resolved payment wizard
route suggestions.

`GET /openreceive/v1/providers`

Returns runtime provider registry entries and metadata for the payment wizard,
including local `icon_path` values. Optional query filters include
`mechanism=pay_invoice|withdraw_to_invoice` and `us=true|false|unknown|null`.

Provider routes are suggestions, not settlement proof or availability
guarantees. The payer chooses a third-party provider, and backend wallet lookup
remains the payment authority.

## Health And Capabilities

`GET /openreceive/v1/health` returns `{ "ok": true }` when the adapter is
mounted.

`GET /openreceive/v1/capabilities` returns a non-secret capability summary.
Wallet-specific secrets, raw NWC connection strings, and wallet diagnostics such
as `get_balance` must not appear in this response.

## Error Shape

Errors use the shared error schema:

```json
{
  "code": "INVALID_REQUEST",
  "message": "Human-readable error",
  "retryable": false
}
```

Codes are the uppercase canonical values from `spec/schemas/error.schema.json`.
Adapters may include `retryable`, `request_id`, or `details` when that context is
available, but applications should still render defensive fallback messages.
