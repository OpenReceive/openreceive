# Rails Quickstart Status

OpenReceive does not have a Rails package yet. This page records the intended
Rails shape so future work stays aligned with the v0.1 contract.

Use the Node and Express quickstart for the current working reference path:

```text
docs/01-quickstart-node.md
```

## Planned Shape

A Rails integration should mount OpenReceive inside the merchant app, not run a
separate daemon. The app owns authentication, order/session lookup, storage,
fulfillment, and worker deployment.

Expected Rails pieces:

- Rails engine or route helpers mounted under `/openreceive/v1`
- server-side receive-only NWC configuration
- ActiveRecord invoice storage
- ActiveJob, Solid Queue, Sidekiq, or GoodJob polling workers
- ActionCable, Turbo Streams, or Hotwire updates for browser state
- idempotent fulfillment hooks after backend settlement verification

## Security Boundary

Rails views, Stimulus controllers, import maps, bundled JavaScript, and mobile
clients must never receive `OPENRECEIVE_NWC`.

The browser receives only display-safe invoice data: BOLT11 invoice text,
Lightning URI, amount, status, and authorized event or lookup URLs. Settlement
must still be confirmed by the Rails backend through `lookup_invoice`.

## Conformance

Future Rails work should consume the shared schemas and vectors, then run the
deterministic mock wallet before live wallet profile tests. It must preserve:

- idempotency scope and request-body conflict behavior
- `amount_msats` boundaries
- metadata size guard under 3900 serialized characters
- polling final lookup and grace verification
- settlement requiring `settled_at` or settled wallet state
- duplicate notification replay safety

Do not publish a Rails package until it passes the shared conformance gate.
