# FastAPI quickstart

FastAPI + React. Requires Python ≥ 3.10, FastAPI ≥ 0.115 (Starlette ≥ 0.40)
and a SQLAlchemy 2 `Engine` for OpenReceive's two tables.

## 1. Install

```sh
pip install "openreceive[fastapi]"
npm install @openreceive/react
```

One Python distribution with framework extras: `openreceive[fastapi]` brings
FastAPI, Starlette and SQLAlchemy; the wallet client (websockets, coincurve,
cryptography), the HTTP engine and the `openreceive` CLI come with the base
package. The npm package is the checkout UI for your frontend. Different
stack? Swap the two: `openreceive[django]` with the Django quickstart; a
bundler-less page uses `@openreceive/elements` instead of React.

|          | Packages                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server   | `openreceive[fastapi]`, `openreceive[django]`, `openreceive[sqlalchemy]` (Flask and plain WSGI/ASGI: [the Flask recipe](../recipes/flask.md)) |
| Frontend | `@openreceive/react`, `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, `@openreceive/elements` (plain HTML) |

Use `uv` or a virtualenv on Python 3.10 or newer; a system Python 3.9 cannot
install the package.

## 2. Migrate the payment tables

```sh
openreceive scaffold payments --alembic --dialect postgres    # or sqlite | mysql
```

`openreceive scaffold payments --alembic` writes one Alembic revision into
`alembic/versions/` that creates `openreceive_payments` (the payment attempts)
and `openreceive_meta` (the reconcile gate) with the DDL frozen in the file.
Set its `down_revision` to your current head (`alembic heads`), then apply it
the way you apply your own: `alembic upgrade head`. It never opens a database
connection.
→ [openreceive scaffold payments](api-reference.md#openreceive-scaffold-payments-python)

No Alembic? `openreceive scaffold payments --sql --dialect postgres` prints
the same DDL for `psql`, a Flyway file, or whatever runs your migrations; in
code, `payments_schema_sql(dialect)` from `openreceive.storage.sql` is the
same string. OpenReceive owns the tables' logic at runtime — locking,
write-once settlement, the reconciliation state machine — and there is
nothing else to generate. Details: [Payment storage](storage.md).

## 3. Add wallet credentials

Put the credentials in the server's environment (a `.env` your process
manager loads, `uvicorn --env-file .env`, or your secret store):

<!-- shared:begin credentials -->
```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments))
   → `NWC_URI`.
2. Optionally set up a [swap provider](https://openreceive.org/set_up_swap_provider)
   → `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP` if you have one).

Never put these values in browser code. Your application refuses to start if
the NWC code also advertises spend methods such as `pay_invoice`; mint a
receive-only code ([Security](security.md)).
<!-- shared:end credentials -->

OpenReceive reads `os.environ`; a `.env` file on disk is not enough on its
own. `uvicorn --env-file .env` loads one in development; in production the
process manager or secret store injects the values. Every variable is on
[Environment variables](environment-variables.md).

## 4. Wire OpenReceive

Twelve lines: your three hooks as a `Host`, a router included under a
prefix, and a lifespan that checks the wallet at startup. The router builds
the wallet client from `NWC_URI` and mounts the framework-free engine; there
is no background reconciler — settlement piggybacks on requests through the
durable gate.

```python
from fastapi import FastAPI
from sqlalchemy import create_engine
from openreceive.fastapi import openreceive_lifespan, openreceive_router
from openreceive.server import Host
from .app import current_user, orders  # your existing models and auth dependency

# OpenReceive's own sync Engine for its two tables — the SAME database as
# your orders, its own connection pool. On SQLite give it a dedicated Engine.
engine = create_engine("postgresql+psycopg://…")

host = Host(
    # The price for a reference — here, your order id — from your own data;
    # OpenReceive converts it into the Lightning invoice. Return None when
    # there is nothing to pay for. `value` is a decimal STRING from the order
    # row, never a float and never a request param. `description` is what the
    # payer is buying, in your own words.
    amount_for=lambda reference: (
        {"currency": "USD", "value": str(order.total), "description": order.summary}
        if (order := orders.find(reference))
        else None
    ),
    # Your own access check: may this caller do this action to this reference?
    # `context.request` is the untouched Starlette Request — reuse the same
    # dependency your order page uses. `context.resource["reference"]` is a
    # claim the payer's browser sent, not proof.
    authorize=lambda context: orders.viewer_may(
        current_user(context.request), context.resource["reference"], context.action
    ),
    # INSIDE the settlement transaction; runs only for the reference's first
    # settled attempt. Use `settlement.connection` (that transaction) for the
    # order write, never a second session. The WHERE clause is the lock.
    on_paid=lambda settlement: settlement.connection.execute(
        orders.claim_paid(settlement.reference, settlement.paid_at)
    ),
)

app = FastAPI(lifespan=openreceive_lifespan(host, engine=engine))
app.include_router(
    # Recommended for public web shops: `rate_limiting=True` caps invoice
    # creation at 60 per client IP per hour. Leave it off (the default) for
    # point-of-sale deployments, where many payers share the terminal's IP.
    openreceive_router(host, engine=engine, rate_limiting=True),
    prefix="/openreceive",
)
```

`authorize` receives the Starlette `Request`, so cookies, headers and whatever
`SessionMiddleware` or auth dependency this app already has are readable
there — FastAPI ships no session of its own, so the payer's `reference` must
be bound to something the request proves. Run uvicorn with `--proxy-headers`
behind a reverse proxy, or `rate_limiting` counts the proxy as the one payer.

**There is no CSRF layer to add.** FastAPI has none, and OpenReceive does not
want one: every mounted route refuses a request whose `Sec-Fetch-Site` header
says `cross-site`, which is what stops another origin's page from minting or
refunding on a logged-in payer's behalf — exactly the protection the Express
and Fastify adapters rely on. Its limit is the header itself: a client that
does not send it (a non-browser, an old browser) is not refused, so
`authorize` stays the actual boundary. [Security](security.md) has the full
account.

`openreceive_lifespan` runs the receive-only wallet preflight when uvicorn
starts and stops the process on a missing, unreachable or spend-capable code —
the deploy fails instead of the first payer. Pass `lazy=True` for tests and
secretless build steps; the first request then checks the wallet and answers
`503 WALLET_UNAVAILABLE` until it passes.
→ [openreceive_router](api-reference.md#openreceive_router) ·
[openreceive_lifespan](api-reference.md#openreceive_lifespan) ·
[the authorize context](api-reference.md#the-authorize-context)

`rate_limiting=True` is for public web shops. Leave it off for point-of-sale,
where many payers share one IP. → [Rate limiting](rate-limiting.md)

An optional worker, `openreceive notifications --app main:app`, listens for
wallet payment notifications so settlement does not wait for the next page
load. → [openreceive notifications](api-reference.md#openreceive-notifications)

Your app also needs an ordinary order-creation route that validates the cart,
prices with exact decimal math, and returns the order id the page will pass as
the `reference`. OpenReceive never prices from payer input.

The `reference` is a string you choose, and it is the fulfillment identity:
your order id — one per thing you fulfill, created before checkout, kept
across retries, never reused. OpenReceive never looks inside it, but `on_paid`
runs once per reference, a new checkout under a reference that already
settled is refused with 409, and a fresh id per page load lets one order be
paid twice.

Naming boundary: the Python API is snake_case (`payment_hash`,
`amount_msats`) and so is everything on the wire — the mounted HTTP routes and
the browser snapshots use the same names.

<!-- shared:begin render -->
## 5. Render checkout

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout reference={order.id} prefix="/openreceive" />;
```

The checkout renders, polls, and settles itself. The compiled `styles.css`
sheets (`@openreceive/react`, `@openreceive/elements`) are self-contained — a
plain `<link rel="stylesheet">` works with no build step — and scoped: every
rule applies only inside what OpenReceive renders, so the sheet is safe next
to any CSS framework (Mantine, Bootstrap, your own reset) in any import order.
<!-- shared:end render -->

<!-- shared:begin render-notes -->
`<Checkout>` is complete as rendered: it already shows the `description` from
`amountFor` and the collapsed transaction-details panel. Do not build a custom
UI to satisfy those rules — they only become your job if you replace the
drop-in ([Checkout UX](checkout-ux.md)).

Match the host page's theme: by default the checkout follows the payer's
stored choice, then the system scheme. If this page is always one theme, lock
it — `<Checkout theme="dark" … />` (`theme` attribute on the custom element) —
so a white card never lands on a dark page. The checkout is styled by CSS
variables under `data-theme`; [Frontend checkout](frontend-checkout.md) has
the knobs.

The payment-method icons are compiled into `@openreceive/browser` and need
nothing from your bundler. The wallet logos and pay tutorials are files in
`@openreceive/provider-data`, and outside Vite/Rollup (esbuild, webpack, a
plain script tag) they cannot resolve their own URLs — the drop-in needs this
exactly as a custom UI does. Serve that package's `dist/assets` tree and pass
the base as `assetBaseUrl="/openreceive-assets"`
([Provider registry](provider-registry.md#assets)).

That is the whole loop: your server owns the price and the order, the payer gets
an invoice, and `onPaid` runs once inside the settlement transaction.
<!-- shared:end render-notes -->

A page without a bundler renders the same checkout as a custom element:
`<openreceive-checkout reference="…" prefix="/openreceive">` from
`@openreceive/elements` (or its standalone build, served from your static
directory). A runnable illustration of the boundary — not a template to copy
models from — is Buy a Button
([`examples/buttons/server/fastapi`](../../examples/buttons/server/fastapi)):
products, visitors and orders in SQLite, the three hooks as the only bridge,
and the smallest correct FastAPI integration of the packaged checkout. Map
that shape onto the models in THIS app.

## 6. Verify

```sh
openreceive doctor --app main:app
```

`openreceive doctor` checks Python, `NWC_URI`, and swap-provider
configuration, and probes the wallet relay to confirm the code is
receive-only. With `--app module:attr` (your FastAPI app, the router, or an
`OpenReceiveApp`) it also confirms the migration ran and names any hook still
on a placeholder; add `--url http://localhost:8000` to confirm the routes are
mounted. Every failing line states its own fix; exit code 1 when anything
fails. `openreceive debug-report` prints the same as a redacted support
report.
→ [openreceive doctor](api-reference.md#openreceive-doctor-python)

Swap credentials (`LSC_URI_*`) stay server-side too: the provider order id and
token live in the attempt's server-only `swap_data` column and never reach a
response or a log ([Automated swaps](automated-swaps.md)).

<!-- shared:begin next -->
## Next

- [Authorization](authorization.md) — your policy boundary
- [Payment storage](storage.md) — the library-owned table and state machine
- [Frontend Checkout](frontend-checkout.md) — browser responsibilities
- [Automated Swaps](automated-swaps.md) — `swap_data`, and what turning swaps on commits you to
- [Swap refunds](swap-refunds.md) — the refund flow, and the per-order URL a payer needs to come back and use it. Read it before setting `LSC_URI_PRIMARY`
- [Security](security.md) — server-only secret boundaries

More on wiring, storage, and routes:
[Authorization](authorization.md), [Payment storage](storage.md),
[API reference](api-reference.md).
<!-- shared:end next -->
