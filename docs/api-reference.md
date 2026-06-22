# API Reference

OpenReceive does not require a daemon. Framework adapters mount these routes
inside your application, usually at `/openreceive/v1`. The authoritative
HTTP contract is `spec/openapi/openreceive-http.v1.yaml`.

The HTTP routes are the backend integration. Server packages use backend
`lookup_invoice` for settlement, route-triggered recovery, and optional
one-shot poll recovery. There is no required daemon, payment notification
listener, webhook bridge, or in-memory event bus.

Server packages also provide OpenReceive-owned persistence for invoice,
idempotency, lifecycle, lookup-gate, and settlement-action state. Your app
attaches hooks after settlement and keeps its own business records in its
existing tables.

Invoice, lookup, refresh, and poll responses return `Cache-Control: no-store`.
Browser responses never contain an NWC connection string or client secret.

## Create Invoice

`POST /openreceive/v1/invoices`

Required header:

- `Idempotency-Key`: stable for your configured OpenReceive scope and
  create-invoice operation.

Request body uses exactly one amount input:

- `amount_msats`: integer from `1000` through `9007199254740991`.
- `fiat`: `{ "currency": "USD", "value": "0.10" }` style decimal string.

Optional fields include `description`, `description_hash`, `expiry`, and
`metadata`. Exactly one of `description` or `description_hash` may be present.
Keep serialized metadata within the NWC payload guard.

Responses:

- `201`: new invoice.
- `200`: idempotent replay of the same request.
- `409`: same idempotency scope with a different request body.

## Read Invoice

`GET /openreceive/v1/invoices/{invoice_id}`

The invoice id is application-scoped and matches `or_inv_[a-z0-9_]+`.
Configure the adapter to authorize this route against the owning order, cart,
checkout session, or user.

## Lookup Invoice

`POST /openreceive/v1/invoices/lookup`

Body contains either `payment_hash` or `invoice`. This route performs backend
wallet verification. Keep it behind the same order, cart, checkout-session,
user, or backend-service authorization that owns the matching invoice.

The lookup response may include `preimage_present`, but app actions still
require settled state from backend wallet verification. A preimage alone is not
settlement proof. If your app configured a backend settlement action hook, a
settled lookup may return `workflow_state: "settlement_action_completed"`,
`settlement_action_state: "completed"`, and `settlement_action_completed_at`
after that hook completes.
If no hook is configured, adapters may complete the settlement action boundary
as a no-op after backend settlement is proven.

## Refresh Invoice

`POST /openreceive/v1/invoices/{invoice_id}/refresh`

Required header:

- `Idempotency-Key`: stable for your configured OpenReceive scope and refresh
  operation.

The body may include `{ "reason": "expired" }`. Refresh creates a new invoice
row linked to the old row through `refreshed_from_invoice_id`; it never mutates
the old invoice in place. Settled invoices return `409`.

Responses:

- `201`: linked replacement invoice created.
- `200`: idempotent replay of the same refresh request.
- `409`: invoice is not refreshable.

## Poll

`POST /openreceive/v1/poll`

Runs one bounded recovery pass through the OpenReceive store. This route is for
platform schedulers and operator tooling; protect it with `auth.poll` or
`OPENRECEIVE_CRON_SECRET`. It is not a long-running worker.

The response summarizes the invoices checked and any transitions found. Lookup
calls are still gated by per-invoice cooldown and a global store-backed token
bucket.

## Lifecycle Events

The authoritative server-side lifecycle event-name contract is
`spec/asyncapi/openreceive-events.v1.yaml`. These events are for logs and
server-side hooks, not for browser SSE streams.

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
as `get_balance` stay out of this response.

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
available. Render a defensive fallback message when an app sees an unfamiliar
detail shape.
