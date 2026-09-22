# FastAPI quickstart

FastAPI + React. Requires Python ≥ 3.10, FastAPI ≥ 0.115 (Starlette ≥ 0.40)
and a SQLAlchemy 2 `Engine` for OpenReceive's two tables.

## 1. Install

```sh
pip install "openreceive[fastapi]"
npm install @openreceive/react
```

OpenReceive is one Python distribution with framework extras.
`openreceive[fastapi]` brings FastAPI, Starlette and SQLAlchemy. The base
package includes the wallet client (websockets, coincurve, cryptography), the
HTTP engine and the `openreceive` CLI. The npm package is the checkout UI for
your frontend. On a different stack, swap the two: use `openreceive[django]`
with the Django quickstart. A page without a bundler uses
`@openreceive/elements` instead of React.

|          | Packages                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Server   | `openreceive[fastapi]`, `openreceive[django]`, `openreceive[sqlalchemy]` (Flask and plain WSGI/ASGI: [the Flask recipe](../recipes/flask.md)) |
| Frontend | `@openreceive/react`, `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, `@openreceive/elements` (plain HTML) |

Use `uv` or a virtualenv on Python 3.10 or newer. A system Python 3.9 cannot
install the package.

## 2. Migrate the payment tables

```sh
openreceive scaffold payments --alembic --dialect postgres    # or sqlite | mysql
```

`openreceive scaffold payments --alembic` writes one Alembic revision into
`alembic/versions/`. The DDL is frozen in the file, and it creates two tables:

- `openreceive_payments`, the payment attempts
- `openreceive_meta`, the reconcile gate

Set the revision's `down_revision` to your current head (`alembic heads`).
Then apply it the way you apply your own revisions: `alembic upgrade head`.
The command never opens a database connection.
→ [openreceive scaffold payments](api-reference.md#openreceive-scaffold-payments-python)

No Alembic? `openreceive scaffold payments --sql --dialect postgres` prints
the same DDL. Feed it to `psql`, a Flyway file, or whatever runs your
migrations. In code, `payments_schema_sql(dialect)` from
`openreceive.storage.sql` returns the same string. OpenReceive owns the
tables' logic at runtime: locking, write-once settlement, and the
reconciliation state machine. There is nothing else to generate. Details: [Payment storage](storage.md).

## 3. Add wallet credentials

Put the credentials in the server's environment. That can be a `.env` your
process manager loads, `uvicorn --env-file .env`, or your secret store:

<!-- shared:begin credentials -->
```dotenv
NWC_URI=
LSC_URI_PRIMARY=
LSC_URI_BACKUP=
```

1. Get a receive-only NWC code from a compatible wallet
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
   Put it in `NWC_URI`.
2. Optional: set up a [swap provider](https://openreceive.org/set_up_swap_provider).
   Put its connection string in `LSC_URI_PRIMARY`, and a second one in
   `LSC_URI_BACKUP` if you have one.

Never put these values in browser code. Your app refuses to start if the NWC
code also advertises spend methods such as `pay_invoice`. Create a
receive-only code instead ([Security](security.md)).
<!-- shared:end credentials -->

OpenReceive reads `os.environ`, so a `.env` file on disk is not enough on its
own. `uvicorn --env-file .env` loads one in development. In production, the
process manager or secret store injects the values.
[Environment variables](environment-variables.md) lists every variable.

## 4. Wire OpenReceive

The wiring takes twelve lines:

- your three hooks as a `Host`
- a router included under a prefix
- a lifespan that checks the wallet at startup

The router builds the wallet client from `NWC_URI` and mounts the
framework-free engine. There is no background reconciler, meaning no job that checks pending
payments on a timer. Settlement runs during normal requests instead, through
the durable reconcile gate.

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

`authorize` receives the Starlette `Request`. Cookies, headers, and whatever
`SessionMiddleware` or auth dependency this app already has are readable
there. FastAPI ships no session of its own, so you must bind the payer's
`reference` to something the request proves. Behind a reverse proxy, run
uvicorn with `--proxy-headers`. Otherwise `rate_limiting` counts the proxy as
the one payer.

**There is no CSRF layer to add.** FastAPI has no CSRF (cross-site request
forgery) layer, and OpenReceive does not want one. Every mounted route refuses
a request whose `Sec-Fetch-Site` header says `cross-site`. That stops another
origin's page from minting or refunding on a logged-in payer's behalf. The
Express and Fastify adapters rely on exactly the same protection. Its limit is
the header itself. A client that does not send it, such as a non-browser or an
old browser, is not refused. So `authorize` stays the actual boundary.
[Security](security.md) has the full account.

`openreceive_lifespan` runs the receive-only wallet preflight when uvicorn
starts. It stops the process if the code is missing, unreachable, or able to
spend. That way the deploy fails instead of the first payer. Pass `lazy=True`
for tests and for build steps that have no secrets. The first request then
checks the wallet, and requests get `503 WALLET_UNAVAILABLE` until the check
passes.
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
your order id. Use one per thing you fulfill, create it before checkout, keep
it across retries, and never reuse it. OpenReceive never looks inside it, but
the reference still matters:

- `on_paid` commits fulfillment once per reference.
- A new checkout under a reference that already settled is refused with 409.
- A fresh id per page load lets one order be paid twice.

Naming boundary: the Python API is snake_case (`payment_hash`,
`amount_msats`), and so is everything on the wire. The mounted HTTP routes and
the browser snapshots use the same names.

<!-- shared:begin render -->
## 5. Render checkout

```tsx
import { Checkout } from "@openreceive/react";
import "@openreceive/react/styles.css";

<Checkout reference={order.id} prefix="/openreceive" />;
```

The checkout renders, polls, and settles itself.

`@openreceive/react` and `@openreceive/elements` each ship a compiled
`styles.css`. Each sheet is self-contained, so a plain
`<link rel="stylesheet">` works with no build step. Each is also scoped: every
rule applies only inside what OpenReceive renders.

Serve the compiled `styles.css` without Tailwind processing. Import it from
JavaScript if your bundler handles CSS, or use a plain
`<link rel="stylesheet">`. Do not `@import` it into your app's Tailwind entry.
Its rules have zero specificity, so your page's styles can override checkout
styles. Scoping does not prevent that.
<!-- shared:end render -->

<!-- shared:begin render-notes -->
`<Checkout>` is complete as rendered. It already shows the `description` from
`amountFor` and the collapsed transaction-details panel. Do not build a custom
UI to show them. The display rules for them become your job only if you
replace the drop-in component ([Checkout UX](checkout-ux.md)).

Match the host page's theme. By default the checkout follows the payer's
stored choice, then the system color scheme. If this page always uses one
theme, lock it with `<Checkout theme="dark" … />`. On the custom element, set
the `theme` attribute. Locking the theme keeps a white card off a dark page.
CSS variables under `data-theme` style the checkout.
[Frontend checkout](frontend-checkout.md) lists the settings you can change.

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos, and the pay tutorials. There is no image file to copy
or serve, and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can wait to load tutorial screenshots until a tutorial first opens.
Single-file builds, including the standalone checkout, include them from the
start. If your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

That is the whole loop. Your server owns the price and the order. The payer
gets an invoice. `onPaid` runs inside the settlement transaction. If that
transaction rolls back, the callback may run again. For delivery to outside
systems, use an outbox in your app: record the message in the transaction and
send it after commit.
<!-- shared:end render-notes -->

A page without a bundler renders the same checkout as a custom element:
`<openreceive-checkout reference="…" prefix="/openreceive">` from
`@openreceive/elements`. You can also serve its standalone build from your
static directory.

Buy a Button is a runnable illustration of the boundary
([`examples/buttons/server/fastapi`](../../examples/buttons/server/fastapi)).
It is not a template to copy models from. It keeps products, visitors and
orders in SQLite, and the three hooks are the only bridge to OpenReceive. It
is the smallest correct FastAPI integration of the packaged checkout. Map that
shape onto the models in THIS app.

## 6. Verify

```sh
openreceive doctor --app main:app
```

`openreceive doctor` checks Python, `NWC_URI`, and swap-provider
configuration. It also probes the wallet relay to confirm the code is
receive-only. With `--app module:attr` (your FastAPI app, the router, or an
`OpenReceiveApp`), it also confirms the migration ran and names any hook still
on a placeholder. Add `--url http://localhost:8000` to confirm the routes are
mounted. Every failing line states its own fix, and the command exits with
code 1 when anything fails. `openreceive debug-report` prints the same output
as a redacted support report.
→ [openreceive doctor](api-reference.md#openreceive-doctor-python)

Then open the checkout in a browser, confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, inspect the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

Swap credentials (`LSC_URI_*`) stay server-side too. The provider order id and
token live in the attempt's server-only `swap_data` column. They never reach a
response or a log ([Automated swaps](automated-swaps.md)).

<!-- shared:begin next -->
## Next

- [Authorization](authorization.md) — your policy boundary
- [Payment storage](storage.md) — the table the library owns, and its state machine
- [Frontend Checkout](frontend-checkout.md) — what the browser side is responsible for
- [Automated Swaps](automated-swaps.md) — `swap_data`, and what turning swaps on commits you to
- [Swap refunds](swap-refunds.md) — the refund flow, and the per-order URL a payer needs to come back and claim a refund. Read it before you set `LSC_URI_PRIMARY`
- [Security](security.md) — which secrets must stay on the server

More on wiring, storage, and routes:
[Authorization](authorization.md), [Payment storage](storage.md),
[API reference](api-reference.md).
<!-- shared:end next -->
