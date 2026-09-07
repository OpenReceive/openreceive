# OpenReceive agent directions (Django)

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
  `createWizardRouteDisplays`. Lightning only. Every image ships inside
  the JavaScript — logos as data URIs, tutorials once `loadPayTutorialImages()`
  resolves (`image` is `undefined` until then) — so serve nothing and set no
  asset option. When it works, the logos and payment icons render; a missing
  image means a CSP `img-src` that blocks `data:`, and the console names it.
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
