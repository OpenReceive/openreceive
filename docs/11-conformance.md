# Conformance

OpenReceive conformance starts with shared source-of-truth files. SDKs and
adapters should not redefine invoice lifecycle, settlement, polling, idempotency,
or amount rules.

## Required Sources

- `spec/schemas/*.schema.json` define invoice, storage, payment event, rate
  quote, error, and provider-registry shapes.
- `spec/test-vectors/*.json` define amount boundaries, fiat conversion,
  idempotency, invoice lifecycle, NWC URI parsing, polling cadence, and
  settlement detection.
- `spec/openapi/openreceive-http.v1.yaml` defines mounted HTTP routes.
- `spec/asyncapi/openreceive-events.v1.yaml` defines invoice event names and
  payloads.

## Local Gate

Run:

```sh
npm run test:ci
```

That command validates schemas and vectors, scans for secrets, checks generated
contract models for staleness, typechecks the TypeScript packages, runs JS
tests, builds the demos, scans generated client bundles for NWC markers, builds
the docs index, and runs the live NWC smoke script when `OPENRECEIVE_NWC` is
set.

Run `npm run generate:models` after changing OpenAPI or AsyncAPI contracts.
`npm run check:generated` fails if the checked-in generated model constants no
longer match the source contracts.

## Settlement Rules

SDKs and adapters must treat an incoming invoice as settled only when
`lookup_invoice` returns `settled_at` or `state == "settled"` /
`transaction_state == "settled"`. A preimage is corroborating data, not final
settlement proof.

Fulfillment hooks may run only after that backend lookup settlement proof. They
must be idempotent; replaying lookup or events must not double-deliver a
product.

## Idempotency Rules

Create-invoice idempotency is scoped to:

```text
merchant_scope + operation + idempotency_key
```

Replaying the same request returns the same invoice. Reusing the same key with a
different request body is a conflict.

Refresh idempotency uses the same scope shape with `operation =
"invoice.refresh"`. Refresh creates a new linked invoice row with
`refreshed_from_invoice_id`; it must not mutate the old invoice in place.

## Live Wallet Smoke

`npm run test:live:nwc` uses `OPENRECEIVE_NWC` when present and skips clearly
when absent. Live runs must use a low-value receive-only NWC secret and must
redact the connection string in all output.

Do not run live wallet tests on untrusted pull requests with secrets available.

## Future SDKs

New SDKs should live in one package directory, consume the shared vectors, and
provide one conformance command. They must not add send-payment methods or
frontend NWC behavior to OpenReceive receive-checkout APIs.

## Testkit

`@openreceive/testkit` provides deterministic receive-client fixtures for SDK
and adapter tests. It can create predictable invoices, look them up by invoice
or payment hash, explicitly mark them settled, expired, or failed, and replay
duplicate `payment_received` notifications.

The testkit is not a daemon and does not emulate Nostr relay behavior. It is a
local conformance helper for code paths that already depend on the
`OpenReceiveReceiveNwcClient` interface.

## Notification Listeners

`startPaymentNotificationListener` in `@openreceive/node` is a small helper for
long-running backend workers. It subscribes to `payment_received`, dedupes by
`payment_hash`, performs `lookupInvoice`, and calls the settled handler only
when backend lookup confirms settlement.

Notifications are at-least-once hints. They wake lookup quickly, but they do
not replace polling and do not fulfill products by themselves.
