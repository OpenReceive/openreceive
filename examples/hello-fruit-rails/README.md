# Rails quickstart

Minimal Rails host for OpenReceive: one `Order`, the generated
`openreceive_payments` table, and a tiny Stimulus checkout page.

This is intentionally smaller than Hello Fruit. Use it to verify
`bin/rails generate openreceive:install` against a real app. For the full
fruit-sticker shop with Postgres, see
[`../hello-fruit/server/rails`](../hello-fruit/server/rails).

This quickstart is **Lightning-only**: it needs just a receive-only `NWC_URI`.
The swap rails (`/openreceive/swaps/*`, configured via `LSC_URI_PRIMARY` /
`LSC_URI_BACKUP`) come from the engine configuration and are exercised by the
full demo, not here.

## What you get

| Piece | Role |
| --- | --- |
| `db/migrate/*_create_orders.rb` | Host order table (string UUID PK) |
| `db/migrate/*_create_openreceive_tables.rb` | Payment attempts plus the `openreceive_meta` reconcile gate, in one migration (from `openreceive:install`; the model is engine-owned) |
| `config/initializers/openreceive.rb` | `authorize`, `load_order`, `amount_for_order`, `on_paid`, and the built-in BTC/USD price feed (`OpenReceive::Rates`) |
| Mounted engine | `/openreceive/*` routes from the OpenAPI contract |

OpenReceive has no database URL of its own. The host owns both tables
(host SQLite here). There is no seed data: the checkout page creates a fresh
$2.00 order ad hoc via `POST /orders`, so `bin/rails db:prepare` is the whole
database setup.

## Run locally

```sh
# from repo root
cp -n .env.example .env   # set receive-only NWC_URI (the LSC_* lines can stay blank)
cd examples/hello-fruit-rails
bundle install
bin/rails db:prepare
bin/dev
```

`bin/dev` runs the web server and the Tailwind watcher from `Procfile.dev`.
There is no reconciler process: every OpenReceive request runs one durably
gated reconcile pass (the `openreceive_meta` gate), so pending attempts settle
or close on any later OpenReceive call even when no browser is polling.

Open http://localhost:3000. Create a $2.00 order, pay the BOLT11, and wait for
settlement. The browser never receives your NWC code.

## Tests

```sh
bin/rails test   # or bin/ci for setup + tests + audits
```

The integration tests stub the NWC wallet and the price feed (static
$50,000/BTC), then exercise the real routes: order creation,
`POST /openreceive/checkouts`, `payments/check` pending → settled, and
`OpenReceive.reconcile!`. No network, no real wallet.

See [Rails quickstart guide](../../docs/guides/quickstart-rails.md).
