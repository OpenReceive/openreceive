# Buy a Button — Django + Postgres

See Bitcoin Lightning checkout in a Django shop, from an ORM-backed order
to a paid receipt and download. The app uses the packaged Python engine,
Django models, and its existing PostgreSQL database.

OpenReceive supports optional swaps from **USDT, USDC, SOL, and ETH** through
a configured swap provider. The provider converts the payment to **BTC over
Lightning**, which settles into the merchant's connected wallet. Available
assets and networks depend on the provider; swaps are optional.

For your own app, start with the [integration quickstart](../../../../docs/guides/quickstart-django.md).
Run demo servers and backing services in Docker. Development-process commands
below are for a Docker environment; builds and test runners may run on the host.

See [`../../README.md`](../../README.md) for what the demo is and why the
boundary falls where it does.

## Running it

From the repository root, in Docker:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI
npm run demo django          # http://localhost:3006
```

For an edit-reload loop, from the repository root:

```sh
npm run dev -w @openreceive/example-buttons-django   # Vite + manage.py runserver, :3006
```

**In development, Vite is the front door.** `vite.config.ts` runs
`uv run python manage.py migrate`, spawns `manage.py runserver` on an internal
port (3106, or `OPENRECEIVE_DJANGO_PORT`) and proxies the API paths (`/shop`,
`/openreceive`, `/images`, `/__testkit`) to it, serving the SPA itself. One
URL, one command, the same host code production runs. In the container
WhiteNoise serves the built `dist/` and `buttonshop.views.spa` answers `/` and
`/checkout/<uuid>` with `index.html`, so a reload on the checkout URL survives.

**The browser never receives your NWC code.** It is read from the
repository-root `.env` (compose) or the process environment by server code
only — Django loads no `.env` on its own — and no part of it reaches a bundle,
a log or an asset.

## Running it with no wallet

```sh
cd examples/buttons/server/django
DEMO_WALLET=testkit OPENRECEIVE_DEMO_DB=/tmp/buttons npx vite --host 127.0.0.1 --port 3006 --configLoader runner
```

Testkit mode replaces THREE THINGS — the wallet, the swap provider and the
price feed — with the engine's in-memory fakes (`openreceive.testing`), and
nothing else: the adapter, the three hooks, the migrations, the views and the
SPA are the production paths. The database is SQLite under
`OPENRECEIVE_DEMO_DB` (default `examples/buttons/.data/`) unless
`DATABASE_URL` points at Postgres; this is a fake wallet, not a fake application.

The fakes mint the same fixtures as every other engine's testkit (payment
hashes are the mint counter in 64 hex characters, the Tron deposit address is
`T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, provider orders are `testkit-swap-N`,
BTC is a static $50,000 so a $1.00 button is 2,000 sats), which is what lets
one Playwright suite drive this stack with the same assertions
(`OPENRECEIVE_E2E_STACK=django npm run test:e2e:smoke`).

The control surface is the same one the other stacks mount
(`docs/internal/testkit-contract.md`):

- `POST /__testkit/settle { payment_hash }`
- `POST /__testkit/expire { payment_hash }`
- `POST /__testkit/swap-step { provider_order_id | pay_in_asset, state }`
- `GET /__testkit/state`

**The route is declared unconditionally and refuses unconditionally.**
`buttonshop.openreceive_service.testkit_enabled()` reads `DEMO_WALLET` and is
the only thing standing between a production boot and a surface that can
settle invoices, so every action is a JSON 404 without it — `tests/test_testkit.py`
asserts exactly that. No compose file sets it either, which
`npm run check:demo-containers` enforces.

## Persistence is host-owned

This app owns its Postgres database. OpenReceive has no database configuration
of its own — the engine's two tables (`openreceive_payments`,
`openreceive_meta`) live in this same host database, created by the migration
the `openreceive.django` app ships and `manage.py migrate` applies alongside
the shop's own.

Four tables are ours:

| table | what it is |
| --- | --- |
| `shop_products` | the price authority. Read fresh on every order creation — never memoized. |
| `shop_users` | a visitor. Two uuids, two timestamps, no credentials. |
| `shop_orders` | one cart checkout. `id` IS the OpenReceive reference. |
| `shop_order_items` | one sku on one order, with name and price SNAPSHOTTED beside a nullable product FK. |

The snapshots are why deactivating or deleting a product cannot break a receipt,
a download or a feed row somebody already paid for.

## Where to read

| file | what it decides |
| --- | --- |
| `buttonshop/openreceive_host.py` | the three hooks. The whole bridge. |
| `buttonshop/shop/models.py` | `ShopOrder.claim_paid` — the guarded conditional UPDATE the money rests on. |
| `buttonshop/shop/identity.py` | the signed cookie, and why a tampered value reads as nobody. |
| `buttonshop/shop/views.py` | `normalized_lines` (the trust boundary) and the two payload builders that must never converge. |
| `buttonshop/openreceive_service.py` | the testkit switch — the only branch in the OpenReceive wiring. |
| `buttonshop/settings.py` | `OPENRECEIVE = {...}`, CSRF left ON, WhiteNoise for the Vite build. |
| `src/client/csrf.ts` | how a static SPA gets Django's CSRF token into `<meta name="csrf-token">`, and why the header is `X-CSRFToken`. |

## CSRF

Django's `CsrfViewMiddleware` stays on for the shop's own `POST /shop/orders`
and for the mounted OpenReceive routes alike. A template-rendered page would
write `<meta name="csrf-token" content="{{ csrf_token }}">`; this SPA has no
template pass, so `src/client/csrf.ts` reads the `csrftoken` cookie
(`ensure_csrf_cookie` on `/shop/bootstrap`) into that meta tag and names the
header Django reads with `<meta name="csrf-header" content="X-CSRFToken">`. The
packaged `<Checkout>` gets the same header name as `csrfHeader="X-CSRFToken"`.

## Settlement is polled, not pushed

The Rails stack pushes settlement over ActionCable. This one does not: the
checkout keeps its own poll loop and the feed refreshes every thirty seconds.
Every OpenReceive call also runs the durably gated opportunistic reconcile, so
a payer who closed the page settles on the next call that wins the gate. The
`notifications` container is the optional NWC-02 listener (plus periodic pass)
for orders paid the moment the wallet sees them.

## The two processes

`compose.yml` runs the same image twice:

| service | command | what it is |
| --- | --- | --- |
| `buttons-django` | the image default (gunicorn) | the web process |
| `notifications` | `manage.py openreceive_notifications` | the long-running worker |

## Tests

```sh
uv run pytest      # the suite, over the engine's fakes
bin/ci             # setup, check, the suite, migration drift, the boundary check, pip-audit
```

`bin/ci` also runs `manage.py makemigrations --check` (the committed shop AND
openreceive migrations match the models) and `script/check_shared_boundary.py`
(this stack may import `shared/shop-types.ts`, the shared helpers and
`shared/client/**`, never `shared/server-node/**` or `shared/client-vanilla/**`).
