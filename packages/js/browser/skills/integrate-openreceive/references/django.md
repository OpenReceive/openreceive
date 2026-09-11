# OpenReceive agent directions (Django)

These directions describe OpenReceive 0.4.6.

Add OpenReceive to a Django project — the app you are already working in. You
do not need a copy of the OpenReceive source: the Python package is on PyPI
(`openreceive[django]`), the frontend packages are on npm (and the package
carries the standalone checkout as static files for projects with no
bundler), and the quickstart is appended to this file in full, so you can do
the whole integration without fetching anything. Prefer the published package
and the mounted routes — do not reimplement wallet RPC, settlement, or pricing.

Do not clone the OpenReceive repository into this app, and do not copy a demo's
models (`ShopOrder`, `ShopUser`, a signed-cookie visitor) over tables that
already exist. Find this application's order, product, and user models —
whatever they are actually named — and map the three hooks onto those.

Keep this application's template layer, its authentication (`django.contrib.auth`
and its `User`, allauth, whatever it runs) and its database. Pick the frontend
package that matches what already renders here (`@openreceive/elements` — or
the packaged static build — for Django templates and HTMX; `/react`, `/vue`,
`/svelte` or `/angular` for an existing SPA) — do not add React to a
templates-and-HTMX app. Reuse the app's existing `request.user` / session in
`authorize`; the shipped migration adds only its own two tables to the app's
database, through `manage.py migrate`. Do not add Django REST Framework for
these routes: the mount is one `include()`, and the engine owns its own gates.

## What OpenReceive is

A payment library that runs inside YOUR server. It mounts HTTP routes in the
application you are editing, issues Lightning invoices against a wallet the
merchant already controls, and calls back into your code when one settles. There
is no OpenReceive account and no API key, and OpenReceive never holds the funds —
the sats land in the wallet the merchant connected.

The one required credential is a receive-only NWC code (Nostr Wallet Connect):
a string from the merchant's wallet that can create invoices and read their
status, and cannot spend. A swap provider (an "LSC" code) optionally lets the
payer send USDT, USDC, ETH or SOL instead, converted into that same
Lightning payment. You supply those credentials and three hooks — `authorize`,
`amount_for`, `on_paid` on a `Host` class named in `settings.OPENRECEIVE`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — check the environment before you write code

Do this before installing the package or editing files.

1. Look for `NWC_URI` in this app's server environment — `.env`, the process
   env, the deploy config, whatever this app already uses (Django itself loads
   no `.env`; `django-environ` or the process manager does). If the app runs in
   a container the value is in none of those: ask the running process
   (`docker exec <container> printenv NWC_URI`), because finding the NAME in a
   compose file proves nothing about the value. Never print or echo the value
   itself; only report whether it is set. Check for `LSC_URI_PRIMARY` in the
   same pass.

   If OpenReceive is already installed here, `manage.py openreceive_doctor`
   answers this whole step in one command — every credential as present or
   missing, the wallet preflight, the two tables, the mount, and whether a hook
   is still on a placeholder. It never prints a value; `--offline` skips the
   relay probe.
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
   > that is a `.env` file the process manager loads, or an exported variable —
   > and tell me when it's set.

   Wait for the user before wiring OpenReceive; do not invent a placeholder
   value. Waiting is not idleness: you may write `.env.example` with the
   variable NAMES only (`NWC_URI=`, `LSC_URI_PRIMARY=`) so the merchant has a
   file to copy, and keep building the parts of the host that do not touch
   OpenReceive — the order model, the cart, the views. The stop guards the
   credential, not the rest of the app.
4. If `LSC_URI_PRIMARY` was not already set, ask the user: "Do you want to
   accept altcoins and stablecoins (USDT, USDC, ETH, SOL) as well as
   Bitcoin?"

   - Yes → send them to https://openreceive.org/set_up_swap_provider for a
     swap-provider (LSC) code, to set as `LSC_URI_PRIMARY` in the same server
     environment. Do NOT wait for it: no application code reads the value, so
     the integration is identical with or without it — the engine picks it up
     from the environment and swaps switch on. What a yes DOES change is the
     refund route back (the swap non-negotiable below): build it as part of
     this integration, not when the code arrives.
   - No → skip it. Bitcoin over Lightning works with `NWC_URI` alone, and you
     can add a swap provider later without changing application code.
5. Check the environment again and confirm `NWC_URI` is present.
   `LSC_URI_PRIMARY` may land later; swaps stay off until it does, and no code
   changes when it arrives.
6. If OpenReceive is ALREADY installed here, check the installed versions of
   `openreceive` (`pip show openreceive`) and `@openreceive/browser` (or the
   `MANIFEST.json` beside the packaged static checkout) against the release
   named at the top of this file. The headless display models below do not
   exist in older versions, and the first tile click throws with nothing saying
   why. Upgrade first — and if this app runs in containers, rebuild the images:
   the package is baked into the image, so an in-place `pip install -U` is
   undone by the next `compose up`.
7. Before the deploy that turns this on, run
   `OPENRECEIVE_PREFLIGHT=1 manage.py check --deploy`: it runs the receive-only
   wallet preflight as a system check (`openreceive.E002` on a missing, dead or
   spend-capable code), because the wallet client is built lazily on the first
   request rather than in `AppConfig.ready()`.

Only then start the quickstart.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the engine — not a second order model,
  and not an association to `OpenReceivePayment`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets.
- The host owns the price. `amount_for` reads it from your own data;
  reject payer-supplied amounts.
- `authorize` runs on every request, and the `resource` it receives is a
  CLAIM the payer made, not proof. Read the framework session; never trust a
  body field. `openreceive_install` writes `authorize = staticmethod(ALLOW_ALL_AUTHORIZE)`,
  a placeholder that allows everything (`manage.py check` warns
  `openreceive.W002` while it is set) — replace it with this app's real
  ownership check, same as `on_paid`.
- `on_paid` must be idempotent. It runs once per `reference` — your order
  id, one per thing you fulfill, created before checkout, kept across retries,
  never reused. A fresh id per page load lets one order be paid twice.
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
  the price from `amount_for` and both drop-ins render it above the
  amount. Without it the checkout is a QR and "$1.00" with no sign of what the
  dollar is for.
- Show the payer the transaction record: `createTransactionDetails(...)` rows,
  collapsed behind a caret, on the live checkout AND on the receipt. A payment
  hash and a deposit txid are the only evidence a payer has that they paid you.
  `<openreceive-checkout>` / React's `<Checkout>` already render this panel and
  the `description` — these two rules cost you code only on a custom UI or your
  own receipt page, never a reason to replace the drop-in. (It returns no rows
  while the rail is `checkout_lock` — before the payer has chosen anything
  there is no transaction — so render the caret only when the rows are
  non-empty.)
- HTTP JSON is snake_case; the browser packages' TypeScript APIs are camelCase.
- Money is integers or decimal strings — never binary floats.

## Your tables, not ours

The shipped migration adds `openreceive_payments` and `openreceive_meta` to THIS
application's database when you run `manage.py migrate`. That is the whole
persistence OpenReceive needs. It does not replace your orders, users, or
products, and you do not join them.

- **Find this app's models first.** They may be named `Order`, `Invoice`,
  `Booking`, `Product`, `Variant`, `User`, `Account` — anything. Wire the hooks
  to those. Do not generate a parallel `ShopOrder` / `ShopProduct` / `ShopUser`
  stack, and do not add a new app for them.
- **The payable row's id is the `reference`.** Create it before checkout, keep
  it across retries, never reuse it. Pass that id to `<openreceive-checkout>`. A
  fresh id per page load lets one order be paid twice.
- **Products (or the catalog) are the price authority.** Order creation reads
  live prices into the order (snapshot line items if this app has them).
  `amount_for` reads only that order — never a payer-supplied amount, never a
  live catalog lookup that could re-price a cart already placed. Return
  `{"currency": ..., "value": ...}` with `value` a decimal STRING, plus a
  `description` of what they are buying.
- **Users own the order; OpenReceive never sees them.** `authorize` uses the
  same ownership check this app already uses on the order detail / pay view —
  `request.user`, `request.session`, a signed cookie, whatever it is. Keep
  Django's auth and its `User` model; `context.request` is the
  `django.http.HttpRequest`, so `request.user` is right there.
  `context.resource["reference"]` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The engine refuses a new checkout under a reference that already
  settled (409).
- **Do not relate to `OpenReceivePayment`.** No `ForeignKey`, no `OneToOne`, no
  `ManyToMany` either direction, and no admin `inline` on it. `reference` is not
  unique (many attempts per order). Fulfillment is a guarded transition on YOUR
  order row inside `on_paid` — `Order.objects.filter(pk=…, state="awaiting_payment").update(…)`
  (or this app's equivalent). Database writes only in the hook; emails, jobs,
  and channel broadcasts in `after_paid` or after commit.
- **Do not wrap the mounted routes in Django REST Framework.** `include("openreceive.django.urls")`
  is the whole mount; DRF authentication classes, renderers and permission
  classes would sit in front of the engine's own JSON-only, same-site and
  authorize gates and change the wire contract. Your DRF views stay yours.

## If you build your own checkout UI

The engine serves JSON only, so the view is yours — but the drop-ins
(`<openreceive-checkout>`, React's `<Checkout>`) already obey all of this. This
list is the short form of https://openreceive.org/guides/checkout-ux.md, for a UI
built on `@openreceive/browser/headless`. Read that before writing components.

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
  `createWizardRouteDisplays`. Lightning only. Logos are data URIs; tutorial
  images load from a JavaScript chunk. For a custom headless UI, load it when
  a tutorial opens and look up the returned table by the tutorial's `path`:

  ```js
  import { loadPayTutorialImages } from "@openreceive/browser/headless";

  const images = await loadPayTutorialImages();
  const src = images[tutorial.path]; // data URI for the selected tutorial
  ```

  Render `src` as the image source and update your UI after loading. Existing
  display objects do not update: their `tutorial.image` stays `undefined` if
  created before loading. Alternatively, await the loader, recreate the displays
  with `createWizardRouteDisplays`, and render the new `tutorial.image`.
  Show the caption while loading or if loading fails; never use an empty image
  source. Deploy all JavaScript chunks and allow `data:` in CSP `img-src`.
  For missing images, check CSP errors, failed chunks, and stale displays.
  Registry paths are lookup keys; there is no asset option or image route.
  The registry answers ~37 wallets: pass
  `providerPreviewLimit` and build "show all" from `display.providerCount`,
  or they push the QR off the screen.

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/authorization.md — before you write `authorize`
- https://openreceive.org/guides/environment-variables.md — every variable, and what is deliberately not one
- https://openreceive.org/guides/storage.md — the engine tables and the attempt state machine
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
- https://openreceive.org/guides/custom-checkout-route.md — advanced: replacing the mounted engine's routes with your own
- https://openreceive.org/guides/react-material-ui-recipe.md — a worked custom UI on a component library
- https://openreceive.org/guides/flask-recipe.md — the same engine as a Flask Blueprint, if this app is Flask after all
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-django.

## Django quickstart

Requires Python ≥ 3.10 and Django ≥ 5.2 (PostgreSQL, SQLite or MySQL).

Install the Python package with the Django extra:

```sh
pip install "openreceive[django]"
```

That is the whole install: `openreceive[django]` brings Django; the wallet
client (websockets, coincurve, cryptography), the HTTP engine and the
`openreceive` CLI come with the base package. Use `uv` or a virtualenv on
Python 3.10 or newer; a system Python 3.9 cannot install it. Hosts that bring
their own NWC client set `OPENRECEIVE["SERVICE"]` instead (below).

Then add the app, point it at a host class, and mount the routes:

```python
# settings.py
INSTALLED_APPS += ["openreceive.django"]

OPENRECEIVE = {
    "HOST": "shop.openreceive_host.Host",   # the class with the three hooks (generated below)
    "PRICE_CURRENCIES": ["USD"],
    "RATE_LIMITING": False,                 # True for public web shops (see below)
    "OPPORTUNISTIC_RECONCILE": True,        # or {"min_interval_seconds": …}; False only with your own worker
    "DATABASE": "default",                  # the DATABASES alias that holds the two engine tables
}
```

```python
# urls.py
from django.urls import include, path
urlpatterns += [path("openreceive/", include("openreceive.django.urls"))]
```

`HOST` is a dotted path, not a callable — cache-safe, `manage.py check`
friendly, the `AUTH_USER_MODEL` idiom. Then run:

```sh
manage.py openreceive_install shop      # writes shop/openreceive_host.py, prints the lines above
manage.py migrate                        # creates openreceive_payments and openreceive_meta
```

`openreceive_install` writes one file — `<app>/openreceive_host.py`, the
three hooks with the generated placeholders wired and the exactly-once
fulfillment note as comments — and prints the settings and urls lines to add.
It never edits `settings.py` or `urls.py`. The migration ships inside the
`openreceive.django` app, so `manage.py migrate` applies it alongside your
own; it adapts to the configured database backend.

The `OpenReceivePayment` model is engine-owned — no model file is generated,
and the migration adds only the engine's two tables to your database. The
engine owns the table's commit locking, write-once settlement, and
reconciliation state machine. `reference` is indexed but not unique (a
reference may have many historical attempts); `payment_hash` is globally
unique. On SQLite give the database
`OPTIONS = {"transaction_mode": "IMMEDIATE"}` (Django ≥ 5.1) so two
concurrent commits for one order queue on the busy timeout instead of failing
with "database is locked" ([Payment storage](https://openreceive.org/guides/storage.md)).

#### Fulfill exactly once

Within OpenReceive's own settlement paths, `on_paid` runs at most once per
reference: a second payment to a second invoice is recorded with
`status_reason = "duplicate_settlement"` and never fulfills again.

The one thing you own: **if anything other than OpenReceive can also fulfill
an order** — an admin action, a second payment processor, a replayed job —
those paths race each other, and `on_paid` must be idempotent. The generated
host module spells this out and shows the guarded transition:

```python
def on_paid(self, settlement: PaymentSettlement) -> None:
    claimed = Order.objects.filter(
        pk=settlement.reference, state="awaiting_payment"
    ).update(state="paid", paid_at=datetime.fromtimestamp(settlement.paid_at, tz=UTC))
    if claimed == 0:
        return  # someone else already fulfilled it

    # FulfillOrder — like Order — is your own application code: ship the goods,
    # enqueue the confirmation email. OpenReceive provides neither.
    FulfillOrder.run(settlement.reference, payment_hash=settlement.payment_hash)
```

Delivery is at-least-once: `on_paid` runs inside the settlement transaction
(the engine wraps it in `transaction.atomic()`), and an exception rolls it back
for the next pass to retry. Keep it to database writes on the order — an email
or webhook sent from here would survive the rollback and go out again. The
`state="paid"` transition above is the flag; drain it after commit from
`after_paid`, the optional fourth method, which runs once after the settlement
transaction committed, or from your own job.

**`QuerySet.update()` fires no signals and calls no `save()`.** That is the
point — it is one conditional `UPDATE`, so the claim is atomic and there is no
model code between the check and the write. It also means no `post_save`
handler runs, which is fine for a job draining the flag and useless for a
model whose transition lives in `save()`. If your model owns the transition
through signals or an overridden `save()`, take a row lock for the duration
instead:

```python
def on_paid(self, settlement: PaymentSettlement) -> None:
    order = Order.objects.select_for_update().filter(pk=settlement.reference).first()  # SELECT … FOR UPDATE
    if order is None or order.state != "awaiting_payment":
        return
    order.state = "paid"
    order.paid_at = datetime.fromtimestamp(settlement.paid_at, tz=UTC)
    order.save()  # signals fire
```

**Unlocking a download works the same way.** If what the payer bought is a
file, do not unlock it in the browser: gate the download view on the paid
order row —
`get_object_or_404(Order, pk=reference, user=request.user, state="paid")` —
and serve the file only then. The `state="paid"` written above is the unlock;
the client never decides an order was fulfilled, it re-reads the row. Buy a
Button's `download` view is this in twenty lines.

Both shapes are idempotent, and both are correct. They differ only in whether
your model layer gets to run: `update()` skips it and is the right default; the
row lock (a no-op on SQLite, where the transaction itself serializes writers)
holds the row for the duration of the method and is what you want when the
transition has to go through your model. The generated fulfillment note says
the same thing — if your fulfillment is a read-modify-write that cannot be
expressed as one conditional `UPDATE`, take the lock.

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
(`examples/buttons/server/django`).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

### Add wallet credentials

Put the credentials in the server's environment:

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

OpenReceive reads `os.environ`; Django does not load a `.env` file on its own.
`django-environ`, an exported shell environment, or your production secret
manager has to put the values there first. The explicit override for a
spend-capable code is `OPENRECEIVE_ALLOW_SPEND_CAPABLE_NWC=true`.
→ [Environment variables](https://openreceive.org/guides/environment-variables.md).

### Configure the host hooks

The host class needs three things: authorization, the trusted price, and
fulfillment. All three receive the `reference` — a string you choose, and the
fulfillment identity: your order id, one per thing you fulfill, created before
checkout, kept across retries, never reused. OpenReceive never looks inside
it, but `on_paid` runs once per reference, a new checkout under a reference
that already settled is refused with 409, and a fresh id per page load lets
one order be paid twice.

```python
# shop/openreceive_host.py — generated by `manage.py openreceive_install shop`, then filled in.
from datetime import UTC, datetime

from openreceive.server import HookContext
from openreceive.storage import PaymentSettlement

from shop.models import Order  # YOUR model — it could be named anything. OpenReceive
                               # never sees it or touches its table; these hooks are the
                               # only bridge between the engine and your data.


class Host:
    # Your policy, called before every checkout/payment/swap request. `context`
    # has three attributes:
    #   context.action    — which route: "checkout.prepare", "checkout.create",
    #                       "payment.check", "swap.quote", "swap.create",
    #                       "swap.read", or "swap.refund"
    #   context.request   — the django.http.HttpRequest; read request.user,
    #                       request.session or cookies from it, as in a view
    #   context.resource  — {"reference": ..., "payment_hash": ...} copied from
    #                       the payer's JSON body. It names an order; it does
    #                       not prove this caller owns it. reference is always a
    #                       validated non-empty str (≤200 chars); payment_hash
    #                       is absent except on payment.check / swap.read /
    #                       swap.refund.
    # Return True to allow, False for a 403. Here: only the signed-in customer
    # who placed the order may act on it.
    def authorize(self, context: HookContext) -> bool:
        order = Order.objects.filter(pk=context.resource["reference"]).first()
        return order is not None and order.user_id == context.request.user.id

    # The price for a reference — here, your order id — from your own data;
    # None when there is nothing to pay for (a 404). `value` is a decimal
    # STRING from the order row, never a float and never a request param.
    # `description` is what the payer is buying, in your own words.
    def amount_for(self, reference: str) -> dict | None:
        order = Order.objects.filter(pk=reference).first()
        if order is None:
            return None
        return {"currency": "USD", "value": str(order.total),
                "description": f"{order.items.count()} items"}

    # Runs inside the settlement transaction, only for the order's first settled
    # attempt. The WHERE clause is the lock: a second fulfillment path of yours
    # (admin action, replayed job) updates zero rows and does nothing. Plain
    # ORM calls, because the engine WRAPS this method in transaction.atomic();
    # `settlement.connection` is None here. (The SQLAlchemy adapters instead
    # hand on_paid the transaction's Connection — the one shape difference.)
    def on_paid(self, settlement: PaymentSettlement) -> None:
        Order.objects.filter(pk=settlement.reference, state="awaiting_payment").update(
            state="paid", paid_at=datetime.fromtimestamp(settlement.paid_at, tz=UTC)
        )
```

`authorize` receives the Django request that carried the payer's call, so
`request.user`, `request.session` and cookies are all there — keep the
project's authentication and its `User`; OpenReceive mints no tokens of its
own. The engine reads nothing else from the request: whatever your middleware
stack put on it is what your policy sees.

CSRF stays on. `CsrfViewMiddleware` is the host's, and the mounted routes run
its check like any other view — a failed check answers with the shared
`403 FORBIDDEN` JSON error instead of the HTML failure page. Render
`<meta name="csrf-token" content="{{ csrf_token }}">` in the template that
shows the checkout, and give the element `csrf-header="X-CSRFToken"` (the
header Django reads; the default is Rails' `X-CSRF-Token`) — the checkout
client sends the token from that tag on every request. A view that renders a
page with no form still needs `{% csrf_token %}` or `ensure_csrf_cookie` for
the cookie to exist; `{{ csrf_token }}` in the meta tag does that on its own.

The generated host module ships `on_paid = staticmethod(LOGGING_ON_PAID)` — a
placeholder that only logs the settlement and fulfills nothing. Replace it
with your real fulfillment (as above); `manage.py check` warns
(`openreceive.W001`) at every boot while the placeholder is still configured,
because orders would otherwise be recorded as settled without ever being
fulfilled. The same applies to `authorize = staticmethod(ALLOW_ALL_AUTHORIZE)`,
the generated allow-all placeholder: it treats possession of the reference as
authorization, which is safe only while references are unguessable, and the
check warns (`openreceive.W002`) until you replace it with your own ownership
check (as above). Replace both, not just `on_paid`. A `HOST` that is missing
or does not import is `openreceive.E001`.

The amount always comes from your own order record; payer-supplied amounts are
rejected. Hosts that bring their own NWC client, price feed or swap providers
set `OPENRECEIVE["SERVICE"]` to the dotted path of a callable
`(env) -> openreceive.server.Service`; everyone else leaves it out.

For public web shops, opt into the per-IP invoice cap with
`"RATE_LIMITING": True` (or `{"limit_per_hour": …, "limit_per_day": …}`);
leave it off (the default) when many payers share one IP. It counts
`REMOTE_ADDR` after your own proxy handling, so behind a reverse proxy put a
trusted-proxy middleware first or the cap counts the proxy.
→ [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

The wallet client — and its receive-only preflight — is built lazily on the
first request, never in `AppConfig.ready()`: that method runs for `migrate`,
`collectstatic` and shells too, and a relay probe there would break them on a
box with no relay access. To fail a deploy on a bad `NWC_URI` instead of
surfacing customer-facing 500s, run the preflight as a system check in your
deploy pipeline:

```sh
OPENRECEIVE_PREFLIGHT=1 manage.py check --deploy    # openreceive.E002 on a missing, dead or spend-capable code
manage.py openreceive_doctor                        # the same, for humans; never prints a secret
```

### Render the checkout

The app serves JSON checkout routes only — rendering is your template. Any
OpenReceive frontend package works against the `/openreceive` mount; the
smallest is the custom element, and the Python package carries its
standalone build as static files, so a Django template needs no JavaScript
bundler at all:

```django
{# templates/orders/pay.html #}
{% load static %}
<meta name="csrf-token" content="{{ csrf_token }}">
<link rel="stylesheet" href="{% static 'openreceive/openreceive-checkout.css' %}">
<script type="module" src="{% static 'openreceive/openreceive-checkout.js' %}"></script>

<openreceive-checkout
  reference="{{ order.pk }}"
  csrf-header="X-CSRFToken"></openreceive-checkout>
```

`openreceive-checkout.js` registers the `<openreceive-checkout>` tag when it
loads (one self-contained ES module, un-minified identifiers), and the
stylesheet is scoped to what OpenReceive renders so it sits safely next to any
CSS framework in any order. `collectstatic` ships both with the rest of your
static files; the package's `MANIFEST.json` names every file and its hash. The
element creates the checkout for `reference`, then renders and polls itself
(its default `prefix` is already `/openreceive`).

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can defer tutorial screenshots until first open; single-file builds
(including the standalone checkout) include them upfront. If your
Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](https://openreceive.org/guides/provider-registry.md#assets)).

Then open the checkout in a browser, confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, inspect the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

Hosts with a JavaScript bundler use the npm packages instead — the same
element from `@openreceive/elements` (`defineElements()` once per page, then
the tag above), or the matching React/Vue/Svelte/Angular wrapper with the
`csrfHeader="X-CSRFToken"` prop, same defaults ([Frontend
checkout](https://openreceive.org/guides/frontend-checkout.md)). Build a custom checkout only if this app
cannot use a drop-in; then `@openreceive/browser/headless` is the API
([Headless checkout](https://openreceive.org/guides/headless-checkout.md)).

### Reconciliation

Settlement runs on the request path. You do not need a cron job. Disable or
tune it with `"OPPORTUNISTIC_RECONCILE"` (`False`, or
`{"min_interval_seconds": …}`).

Optionally, run one worker so settlement does not wait for the next page
load:

```sh
manage.py openreceive_notifications
```

It listens for NWC-02 `payment_received` notifications AND runs a periodic
reconcile pass (`OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS`, default
15) in the same process — the safety net for notifications missed while it was
down. One process total, not one per web instance.

`manage.py openreceive_reconcile` is the one-shot primitive if you want to
drive a pass yourself.

### Swap secrets

The Python engine recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP` using the
shared [Lightning Swap Connect](https://openreceive.org/guides/lightning-swap-connect.md) vectors: setting
either one auto-builds the matching provider, so an app that wants swaps only
supplies the connection strings ([Environment
variables](https://openreceive.org/guides/environment-variables.md)). `OPENRECEIVE["SERVICE"]` is the
override knob — build the `Service` with your own providers, or an empty list
to disable swaps.

One `openreceive_payments` row holds at most one provider order in its
server-only `swap_data` column. The engine excludes `swap_data` from the
model's `repr`, from the read-only admin it registers, and from every public
dict. Do not serialize it, log it, or return it from your own API; it may
contain a provider credential.

**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late, which leaves it `refund_required` at the provider with
only your UI able to claim it — and the payer claims it on a second visit,
after leaving your page for an address in another wallet. That needs a
per-order URL your app serves, a route that restores the order behind it, and
something that restores the ATTEMPT, since `/checkouts/prepare` returns none.
[Swap refunds](https://openreceive.org/guides/swap-refunds.md) is the whole of it; read it before you set
`LSC_URI_PRIMARY`.
