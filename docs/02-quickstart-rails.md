# Rails Quickstart Status

OpenReceive now has an initial Rails adapter helper package at
`packages/ruby/openreceive-rails`. It can wrap an injected receive-only client
for idempotent invoice creation, authorized lookup, backend settlement
verification, polling-worker verification, passive notification handling, and
duplicate-safe settlement action tracking. It also includes a package-owned
ActiveRecord invoice store, initial migration and model templates for the
invoice storage shape, controller, job, channel, route, install-generator
templates, generated poll/listen/doctor rake tasks, an invoice Hotwire partial,
production fail-closed checks for in-memory storage, and optional mounted engine
routes with `503 WALLET_UNAVAILABLE` handling for an injected unavailable-wallet client.
Complete Rails demo smoke is still pending.
An initial Rails Hotwire Hello Fruit demo skeleton exists at
`examples/hello-fruit/server/rails-hotwire`; it is covered by the demo
container validator, has a root `npm run demo rails` launcher target, prepares
its SQLite database on container boot, and boots without `OPENRECEIVE_NWC`;
invoice creation fails closed until the receive-only NWC string is configured.
Full bundle/build smoke is still pending.

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
merchant settlement actions, and worker deployment. The Rails package should
own the two runner entry points the app deploys:

- `bin/rails openreceive:poll` or a generated recurring job for settlement
  polling and restart recovery
- `bin/rails openreceive:listen` or a generated long-running job for
  payment_received notification subscriptions where the wallet supports them
- `bin/rails openreceive:doctor` to check storage, migration, NWC preflight,
  and worker readiness. The doctor task fails if the app is still using the
  Ruby in-memory test store or a store without migration diagnostics.

Deploy those as separate backend processes or worker roles. Do not put the
long-running polling loop or notification subscription in a web request thread.
The Rails package should generate and own the OpenReceive invoice tables and
ActiveRecord model; the host app should not hand-design those rows. The host app
provides order/user references in metadata and app-owned hooks such as
`settlement_action`.

Expected Rails pieces:

- Ruby core helpers from `openreceive`
- Rails adapter helpers from `openreceive-rails`
- Rails engine or route helpers mounted under `/openreceive/v1`
- server-side receive-only NWC configuration
- package-owned ActiveRecord invoice storage using the provided templates
- ActiveJob, Solid Queue, Sidekiq, or GoodJob polling and notification workers
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
