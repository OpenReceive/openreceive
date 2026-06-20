# Rails Quickstart Status

OpenReceive now has an initial Rails adapter helper package at
`packages/ruby/openreceive-rails`. It can wrap an injected receive-only client
for idempotent invoice creation, authorized lookup, backend settlement
verification, polling-worker verification, passive notification handling, and
duplicate-safe settlement action tracking. It also includes initial
ActiveRecord migration and model templates for the invoice storage shape, plus
controller, job, channel, route, install-generator templates, an invoice
Hotwire partial, and optional mounted engine routes with
`503 WALLET_UNAVAILABLE` handling for an injected unavailable-wallet client.
Complete Rails demo smoke is still pending.
An initial Rails Hotwire Hello Fruit demo skeleton exists at
`examples/hello-fruit/server/rails-hotwire`; it is covered by the demo
container validator, has a root `npm run demo rails` launcher target, and boots
without `OPENRECEIVE_NWC`; invoice creation fails closed until the receive-only
NWC string is configured. Full bundle/build smoke is still pending.

The Ruby core-helper package at `packages/ruby/openreceive` provides
vector-backed exact money and settlement helpers, NWC URI parse/redaction,
receive-only NIP-47 request mapping, polling/idempotency helpers, and an
in-memory test store. It also includes a receive-only wrapper for
`nwc-ruby` clients using `NwcRuby::Client.from_uri` and the documented
`make_invoice` / `lookup_invoice` methods, plus a fail-closed
`UnavailableReceiveClient` for demo and development boot paths without wallet
configuration.
Run `OPENRECEIVE_ENV_FILE=.env npm run test:live:ruby:nwc` for the current Ruby
preflight; it parses and redacts the configured NWC URI, runs `get_info` when
`nwc-ruby` is installed, and creates an invoice only when
`OPENRECEIVE_LIVE_CREATE_INVOICE=1`.

Use the Node and Express quickstart for the current working reference path:

```text
docs/01-quickstart-node.md
```

## Planned Shape

A Rails integration should mount OpenReceive inside the merchant app, not run a
separate daemon. The app owns authentication, order/session lookup, storage,
merchant settlement actions, and worker deployment.

Expected Rails pieces:

- Ruby core helpers from `openreceive`
- Rails adapter helpers from `openreceive-rails`
- Rails engine or route helpers mounted under `/openreceive/v1`
- server-side receive-only NWC configuration
- ActiveRecord invoice storage using the provided templates as the starting point
- ActiveJob, Solid Queue, Sidekiq, or GoodJob polling workers
- ActionCable, Turbo Streams, or Hotwire updates for browser state using the
  provided channel/job templates as the starting point
- idempotent settlement action hooks after backend settlement verification

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
Do not use the Ruby in-memory store as production Rails persistence.
