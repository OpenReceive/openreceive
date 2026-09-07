# OpenReceive agent directions (FastAPI)

These directions describe OpenReceive 0.4.4.

Add OpenReceive to a FastAPI application — the app you are already working in.
You do not need a copy of the OpenReceive source: the engine is on PyPI
(`openreceive[fastapi]`), the checkout UI is on npm, and the quickstart is
appended to this file in full, so you can do the whole integration without
fetching anything. Prefer the published packages and the routes the router
serves — do not reimplement wallet RPC, settlement, or pricing.

Do not clone the OpenReceive repository into this app, and do not copy a demo's
models (`ShopOrder`, a signed-cookie visitor, an in-memory catalog) over tables
that already exist. Find this application's order, product, and user models —
whatever they are actually named — and map the three hooks onto those.

Keep this application's frontend framework, authentication and database. Pick
the UI package that matches the frontend that is already here
(`@openreceive/react`, `/vue`, `/svelte`, `/angular`, or `/elements` for
plain HTML or Jinja templates) — do not add React to an HTMX app. Keep
FastAPI's dependency system: the auth dependency this app already resolves
its user with is what `authorize` should call on `context.request`, and the
database OpenReceive gets is a sync SQLAlchemy `Engine` for the SAME
database this app already uses.

## What OpenReceive is

A payment library that runs inside YOUR server. It is an `APIRouter`
(`openreceive_router`, included under `/openreceive`) that serves its HTTP
routes inside the application you are editing, issues Lightning invoices
against a wallet the merchant already controls, and calls back into your code
when one settles. There is no OpenReceive account and no API key, and
OpenReceive never holds the funds — the sats land in the wallet the merchant
connected.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets the
payer send USDT, USDC, ETH or SOL instead, converted into that same
Lightning payment. You supply those credentials and three hooks — `authorize`, `amountFor`,
`onPaid`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — check the environment before you write code

Do this before installing packages or editing files.

1. Look for `NWC_URI` in this app's server environment — `.env`, the process
   env, the deploy config, whatever this app already uses. If the app runs in a
   container the value is in none of those: ask the running process
   (`docker exec <container> printenv NWC_URI`), because finding the NAME in a
   compose file proves nothing about the value. Never print or echo the value
   itself; only report whether it is set. Check for `LSC_URI_PRIMARY` in the
   same pass.
2. If BOTH are already set — the common case in an existing app — say so and go
   straight to the quickstart. Steps 3 and 4 are for an environment that is
   missing one; do not stop to ask about altcoins that are already configured.
   If only `NWC_URI` is set, Bitcoin already works: continue, and raise the
   altcoin question at step 4 rather than blocking on it.
3. If `NWC_URI` is missing or empty, stop and tell the user exactly what to
   create:

   > OpenReceive cannot issue an invoice without a receive-only NWC code. Get
   > one at https://openreceive.org/get_a_nwc_code_to_receive_payments, then
   > put `NWC_URI=<the code>` in this app's server environment — for most apps
   > that is a `.env` file in the project root — and tell me when it's set.

   Wait for the user before wiring OpenReceive; do not invent a placeholder
   value. Waiting is not idleness: you may write `.env.example` with the
   variable NAMES only (`NWC_URI=`, `LSC_URI_PRIMARY=`) so the merchant has a
   file to copy, and keep building the parts of the host that do not touch
   OpenReceive — the order model, the cart, the routes. The stop guards the
   credential, not the rest of the app.
4. If `LSC_URI_PRIMARY` was not already set, ask the user: "Do you want to
   accept altcoins and stablecoins (USDT, USDC, ETH, SOL) as well as
   Bitcoin?"

   - Yes → send them to https://openreceive.org/set_up_swap_provider for a
     swap-provider (LSC) code, to set as `LSC_URI_PRIMARY` in the same server
     environment. Do NOT wait for it: no application code reads the value, so
     the integration is identical with or without it — the library picks it up
     from the environment and swaps switch on. What a yes DOES change is the
     refund route back (the swap non-negotiable below): build it as part of
     this integration, not when the code arrives.
   - No → skip it. Bitcoin over Lightning works with `NWC_URI` alone, and you
     can add a swap provider later without changing application code.
5. Check the environment again and confirm `NWC_URI` is present.
   `LSC_URI_PRIMARY` may land later; swaps stay off until it does, and no code
   changes when it arrives.
6. If OpenReceive is ALREADY installed here, check the installed versions of
   `openreceive` (`pip show openreceive`) and `@openreceive/browser` against
   the release named at the top of this file. The headless display models
   below do not exist in older versions, and the first tile click throws with
   nothing saying why. Upgrade first.
7. Run `openreceive doctor --app <module>:app` (or `--offline` before the
   router exists). It reports `NWC_URI` presence without printing it, probes
   the wallet, and once the router is wired names any hook still on a
   placeholder and whether the migration ran. Exit code 1 is a finding to
   fix, not a reason to skip the check.

Only then start the quickstart.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the library — not a second order model,
  and not a Prisma/Drizzle relation to `openreceive_payments`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets.
- The host owns the price. `amount_for` reads it from your own data; reject
  payer-supplied amounts.
- `authorize` runs on every request, and the `resource` it receives is a CLAIM
  the payer made, not proof. Read the Starlette request's session, cookie or
  auth dependency; never trust a body field.
- `on_paid` must be idempotent. It runs once per `reference` — your order id, one
  per thing you fulfill, created before checkout, kept across retries, never
  reused. A fresh id per page load lets one order be paid twice.
- Receive-only NWC is required; a spend-capable code fails closed at boot unless
  explicitly overridden.
- There is NO merchant-initiated refund of a settled Lightning payment, because
  the wallet cannot spend. Swap refunds — a payer reclaiming a deposit that
  never converted — are the only refund OpenReceive performs, and only from the
  `refund_required` provider state. Do not build, promise, or imply a Lightning
  refund path.
- IF YOU TURN SWAPS ON, BUILD THE ROUTE BACK. A deposit that arrives short or
  late becomes `refund_required`, and the payer claims it on a SECOND VISIT,
  after leaving your page to fetch an address from another wallet. Three things
  must exist or that money is unreachable through your UI: a per-order URL your
  server serves (`/checkout/:reference` — `syncUrl` on the drop-ins), your own
  order-summary route to restore the order from, and the ATTEMPT.
  `/checkouts/prepare` returns no attempts, so a checkout rebuilt from the
  reference alone opens on the method grid. Re-picking the same coin
  (`POST /swaps`) re-serves the committed attempt — but only while it is live,
  and the shadow invoice behind a swap lasts about half an hour, after which the
  same click mints a NEW deposit address and the refund is off-screen. Keep the
  `payment_hash` and reopen the attempt with `POST /swaps/status`, which has no
  such window. https://openreceive.org/guides/swap-refunds.md
- Show the payer WHAT THEY ARE BUYING. Return an optional `description` beside
  the price from `amount_for` and both drop-ins render it above the amount.
  Without it the checkout is a QR and "$1.00" with no sign of what the dollar
  is for.
- Show the payer the transaction record: `createTransactionDetails(...)` rows,
  collapsed behind a caret, on the live checkout AND on the receipt. A payment
  hash and a deposit txid are the only evidence a payer has that they paid you.
  `<Checkout>` / `<openreceive-checkout>` already render this panel and the
  `description` — these two rules cost you code only on a custom UI or your own
  receipt page, never a reason to replace the drop-in. (It returns no rows
  while the rail is `checkout_lock` — before the payer has chosen anything
  there is no transaction — so render the caret only when the rows are
  non-empty.)
- Include the router under the prefix — `app.include_router(
  openreceive_router(host, engine=engine), prefix="/openreceive")` — and give
  the app `lifespan=openreceive_lifespan(host, engine=engine)` so a bad wallet
  stops the deploy. Do not add a CSRF layer for these routes: FastAPI has
  none and the engine's `Sec-Fetch-Site: cross-site` refusal is the
  protection. Behind a reverse proxy run uvicorn with `--proxy-headers`, or
  `rate_limiting` counts the proxy as the one payer.
- The engine is synchronous by design: the router's endpoint runs in
  Starlette's threadpool. Do not wrap it in `async def` code of your own, and
  do not hand OpenReceive an async database session — it wants a sync
  SQLAlchemy `Engine`.
- HTTP JSON is snake_case, and so is the Python API (`payment_hash`,
  `amount_msats`).
- Money is integers or decimal strings — never binary floats.

## Your tables, not ours

`openreceive scaffold payments --alembic` (or `--sql`) emits
`openreceive_payments` and `openreceive_meta` for THIS application's database.
That is the whole persistence OpenReceive needs. It does not replace your
orders, users, or products, and you do not join them.

- **Find this app's models first.** They may be named `Order`, `Invoice`,
  `Booking`, `Product`, `Variant`, `User`, `Account` — anything. Wire the hooks
  to those. Do not generate a parallel `ShopOrder` / `ShopProduct` / `ShopUser`
  stack.
- **The payable row's id is the `reference`.** Create it before checkout, keep
  it across retries, never reuse it. Pass that id to `<Checkout>` /
  `<openreceive-checkout>`. A fresh id per page load lets one order be paid
  twice.
- **Products (or the catalog) are the price authority.** Order creation reads
  live prices into the order (snapshot line items if this app has them).
  `amount_for` reads only that order — never a payer-supplied amount, never a
  live catalog lookup that could re-price a cart already placed. Return
  `{"currency", "value"}` as a decimal STRING, plus a `description` of what
  they are buying.
- **Users own the order; OpenReceive never sees them.** `authorize` uses the
  same ownership check this app already uses on the order show / pay page —
  the `current_user` dependency, a session cookie, whatever it is, resolved
  from `context.request`. `context.resource["reference"]` is a claim the
  payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The library refuses a new checkout under a reference that already
  settled (409).
- **Pass a sync SQLAlchemy `Engine` for this app's database.** Do not add an
  ORM relationship from Order to `openreceive_payments`, and do not implement
  `PaymentRepository` unless no SQLAlchemy engine can reach this database.
  `reference` is not unique (many attempts per order). Fulfillment is a
  guarded transition on YOUR order row inside `on_paid` — `UPDATE … WHERE
  state = 'awaiting_payment'` (or this app's equivalent) through
  `settlement.connection`, the settlement transaction's own connection, not a
  second session from your ORM. Database writes only in the hook; emails,
  jobs, and pushes in `after_paid` or after commit.

## If you build your own checkout UI

The drop-ins (`<Checkout>`, `<openreceive-checkout>`) already obey all of this.
This list is the short form of https://openreceive.org/guides/checkout-ux.md, for a
UI built on `@openreceive/browser/headless`. Read that before writing
components.

- `createCheckoutController` is the engine. Do not hand-roll a poll loop.
- `createCheckoutStatusModel` for the status line. Do not draw a
  Cart → Pay → Done stepper. Read the model's `phase`, not the snapshot's.
- `resolveWizardSelection` decides whether to ask "which network?". A
  one-network asset starts the swap from the tile. Key `selectedAssetByGroup`
  by group (`USDT`), valued by `pay_in_asset` (`USDT_TRON`).
- `createMethodGridDisplay` for tiles, including `limitMessage` so an
  unavailable method says the minimum in the payer's currency.
- `createSwapDisplayModel` → `display.copyRows` for deposits: address, memo,
  and the bare amount each get a copy row. Render `swap.networkWarning*` as
  the model gives it.
- `createCheckoutSession` owns mint and swap start. To start swaps, pass its
  `swap` option (`selection`, `prefix`, `fetch`) together. Without it
  `startSwap` reports through `onError`.
- `createQrSvg` is async. Use `createQrSvgController` so you do not render
  `[object Promise]`.
- `checkoutLabels` for every payer-facing string. Only write copy it lacks.
- `stageSwapRefund` then `confirmSwapRefund` — only the second submits.
  Validate with `getSwapRefundFormError`. Treat `409` as a normal outcome.
- Pass `{ resumable: true }` to `createSwapDisplayModel` when the payer has
  a URL they can come back to, and render `display.refundReturnLabel`.
  Resume helpers (`createGuestCheckoutResume`, `createGuestOrderFetcher`)
  are on `@openreceive/browser`, not `/headless`.
- A refund replaces the deposit panel. On `refund_required` also drop
  "switch payment method".
- No "Open wallet" button on desktop.
- Wallet suggestions: `getPaymentWizardRoutes()` +
  `createWizardRouteDisplays`. Lightning only. Every image ships inside
  the JavaScript — logos as data URIs, tutorials once `loadPayTutorialImages()`
  resolves (`image` is `undefined` until then) — so serve nothing and set no
  asset option. When it works, the logos and payment icons render; a missing
  image means a CSP `img-src` that blocks `data:`, and the console names it.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/authorization.md — before you write `authorize`
- https://openreceive.org/guides/environment-variables.md — every variable, and what is deliberately not one
- https://openreceive.org/guides/storage.md — the payment tables and the attempt state machine
- https://openreceive.org/guides/frontend-checkout.md — the drop-in's props, attributes and slots
- https://openreceive.org/guides/checkout-ux.md — read before building any custom UI
- https://openreceive.org/guides/headless-checkout.md — the controller, the display models, refunds
- https://openreceive.org/guides/provider-registry.md — where the wallet logos and pay
  tutorials come from: inside the JavaScript, nothing to serve. This is the page
  that owns the image rule, not the summary in checkout-ux.md
- https://openreceive.org/guides/automated-swaps.md — only if `LSC_URI_PRIMARY` is set
- https://openreceive.org/guides/swap-refunds.md — the refund flow, and the route back to it. Read it before you turn swaps on
- https://openreceive.org/guides/lightning-swap-connect.md — what an `LSC_URI_*` code actually is
- https://openreceive.org/guides/price-feeds.md — where the fiat→sats rate comes from, and how to replace it
- https://openreceive.org/guides/host-testing.md — testing your three hooks without a live wallet or provider
- https://openreceive.org/guides/rate-limiting.md — before a public shop goes live
- https://openreceive.org/guides/security.md and https://openreceive.org/guides/deploying.md — before this goes anywhere real
- https://openreceive.org/guides/api-reference.md — every route, option and error code
- https://openreceive.org/guides/custom-checkout-route.md — advanced: replacing the shipped adapter's routes with your own
- https://openreceive.org/guides/react-material-ui-recipe.md — a worked custom UI on a component library
- https://openreceive.org/guides/flask-recipe.md — the same engine as a Flask Blueprint, if this app is Flask after all
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-fastapi.

## FastAPI quickstart

FastAPI + React. Requires Python ≥ 3.10, FastAPI ≥ 0.115 (Starlette ≥ 0.40)
and a SQLAlchemy 2 `Engine` for OpenReceive's two tables.

### 1. Install

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
| Server   | `openreceive[fastapi]`, `openreceive[django]`, `openreceive[sqlalchemy]` (Flask and plain WSGI/ASGI: the Flask recipe) |
| Frontend | `@openreceive/react`, `@openreceive/vue`, `@openreceive/svelte`, `@openreceive/angular`, `@openreceive/elements` (plain HTML) |

Use `uv` or a virtualenv on Python 3.10 or newer; a system Python 3.9 cannot
install the package.

### 2. Migrate the payment tables

```sh
openreceive scaffold payments --alembic --dialect postgres    # or sqlite | mysql
```

`openreceive scaffold payments --alembic` writes one Alembic revision into
`alembic/versions/` that creates `openreceive_payments` (the payment attempts)
and `openreceive_meta` (the reconcile gate) with the DDL frozen in the file.
Set its `down_revision` to your current head (`alembic heads`), then apply it
the way you apply your own: `alembic upgrade head`. It never opens a database
connection.
→ [openreceive scaffold payments](https://openreceive.org/guides/api-reference.md#openreceive-scaffold-payments-python)

No Alembic? `openreceive scaffold payments --sql --dialect postgres` prints
the same DDL for `psql`, a Flyway file, or whatever runs your migrations; in
code, `payments_schema_sql(dialect)` from `openreceive.storage.sql` is the
same string. OpenReceive owns the tables' logic at runtime — locking,
write-once settlement, the reconciliation state machine — and there is
nothing else to generate. Details: [Payment storage](https://openreceive.org/guides/storage.md).

### 3. Add wallet credentials

Put the credentials in the server's environment (a `.env` your process
manager loads, `uvicorn --env-file .env`, or your secret store):

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
receive-only code ([Security](https://openreceive.org/guides/security.md)).

OpenReceive reads `os.environ`; a `.env` file on disk is not enough on its
own. `uvicorn --env-file .env` loads one in development; in production the
process manager or secret store injects the values. Every variable is on
[Environment variables](https://openreceive.org/guides/environment-variables.md).

### 4. Wire OpenReceive

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
`authorize` stays the actual boundary. [Security](https://openreceive.org/guides/security.md) has the full
account.

`openreceive_lifespan` runs the receive-only wallet preflight when uvicorn
starts and stops the process on a missing, unreachable or spend-capable code —
the deploy fails instead of the first payer. Pass `lazy=True` for tests and
secretless build steps; the first request then checks the wallet and answers
`503 WALLET_UNAVAILABLE` until it passes.
→ [openreceive_router](https://openreceive.org/guides/api-reference.md#openreceive_router) ·
[openreceive_lifespan](https://openreceive.org/guides/api-reference.md#openreceive_lifespan) ·
[the authorize context](https://openreceive.org/guides/api-reference.md#the-authorize-context)

`rate_limiting=True` is for public web shops. Leave it off for point-of-sale,
where many payers share one IP. → [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

An optional worker, `openreceive notifications --app main:app`, listens for
wallet payment notifications so settlement does not wait for the next page
load. → [openreceive notifications](https://openreceive.org/guides/api-reference.md#openreceive-notifications)

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

### 5. Render checkout

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

`<Checkout>` is complete as rendered: it already shows the `description` from
`amountFor` and the collapsed transaction-details panel. Do not build a custom
UI to satisfy those rules — they only become your job if you replace the
drop-in ([Checkout UX](https://openreceive.org/guides/checkout-ux.md)).

Match the host page's theme: by default the checkout follows the payer's
stored choice, then the system scheme. If this page is always one theme, lock
it — `<Checkout theme="dark" … />` (`theme` attribute on the custom element) —
so a white card never lands on a dark page. The checkout is styled by CSS
variables under `data-theme`; [Frontend checkout](https://openreceive.org/guides/frontend-checkout.md) has
the knobs.

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can defer tutorial screenshots until first open; single-file builds
(including the standalone checkout) include them upfront. If your
Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](https://openreceive.org/guides/provider-registry.md#assets)).

That is the whole loop: your server owns the price and the order, the payer gets
an invoice, and `onPaid` runs once inside the settlement transaction.

A page without a bundler renders the same checkout as a custom element:
`<openreceive-checkout reference="…" prefix="/openreceive">` from
`@openreceive/elements` (or its standalone build, served from your static
directory). A runnable illustration of the boundary — not a template to copy
models from — is Buy a Button
(`examples/buttons/server/fastapi`):
products, visitors and orders in SQLite, the three hooks as the only bridge,
and the smallest correct FastAPI integration of the packaged checkout. Map
that shape onto the models in THIS app.

### 6. Verify

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
→ [openreceive doctor](https://openreceive.org/guides/api-reference.md#openreceive-doctor-python)

Then open the checkout in a browser, confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, inspect the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

Swap credentials (`LSC_URI_*`) stay server-side too: the provider order id and
token live in the attempt's server-only `swap_data` column and never reach a
response or a log ([Automated swaps](https://openreceive.org/guides/automated-swaps.md)).
