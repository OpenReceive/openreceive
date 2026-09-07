# OpenReceive agent directions (Laravel)

These directions describe OpenReceive 0.4.5.

Add OpenReceive to a Laravel application — the app you are already working in.
You do not need a copy of the OpenReceive source: the package is on Packagist
(`openreceive/laravel`), the frontend packages are on npm, and the quickstart is
appended to this file in full, so you can do the whole integration without
fetching anything. Prefer the published package and the routes its service
provider mounts — do not reimplement wallet RPC, settlement, or pricing.

Do not clone the OpenReceive repository into this app, and do not copy a demo's
models (`ShopOrder`, `ShopUser`, an encrypted-cookie visitor) over tables that
already exist. Find this application's order, product, and user models — whatever
they are actually named — and map the three hooks onto those.

Keep this application's view layer, its authentication (Breeze, Fortify,
Jetstream, Sanctum, a plain session guard — whatever `Auth` already uses), its
Eloquent models and its database. Pick the frontend package that matches what
already renders here (`@openreceive/elements` for Blade/Livewire/Inertia-less
pages; `/react`, `/vue`, `/svelte` or `/angular` for an existing SPA or Inertia
app) — do not add React to a Blade app. Reuse the app's existing
`$request->user()` or session in `Host::authorize`; the engine's migration adds
only its own two tables to the app's database, through `php artisan migrate`.

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
`amountFor`, `onPaid` on one `App\OpenReceive\Host` class;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — check the environment before you write code

Do this before installing the package or editing files.

1. Look for `NWC_URI` in this app's server environment — `.env`, the deploy
   config, Forge/Vapor/Envoyer environment panels, whatever this app already
   uses. If the app runs in a container the value is in none of those: ask the
   running process (`docker exec <container> printenv NWC_URI`), because finding
   the NAME in a compose file or `.env.example` proves nothing about the value.
   Never print or echo the value itself; only report whether it is set. Check
   for `LSC_URI_PRIMARY` in the same pass. Remember `php artisan config:cache`:
   a cached config captured the values at cache time, and editing `.env`
   afterwards changes nothing until the cache is rebuilt.

   If OpenReceive is already installed here, `php artisan openreceive:doctor`
   answers this whole step in one command — every credential as set/unset, the
   host class and which hooks are still placeholders, the route mount, and the
   wallet preflight. It never prints a value.
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
   `openreceive/laravel` (`composer show openreceive/laravel`) and
   `@openreceive/browser` against the release named at the top of this file.
   The headless display models below do not exist in older versions, and the
   first tile click throws with nothing saying why. Upgrade first — and if this
   app runs in containers, rebuild the images: `vendor/` is baked into the
   image, so an in-place `composer update` is undone by the next `compose up`.

Only then start the quickstart.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the engine — not a second order model,
  and not an Eloquent model over `openreceive_payments`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets.
- The host owns the price. `amountFor` reads it from your own data; reject
  payer-supplied amounts.
- `authorize` runs on every request, and the `resource` it receives is a CLAIM
  the payer made, not proof. Read the Illuminate request it is handed — the
  session, `$request->user()`; never trust a body field. `openreceive:install`
  scaffolds `use AllowAllAuthorize;`, a placeholder trait that allows
  everything (the engine warns at boot while it is there) — replace it with
  this app's real ownership check, same as `onPaid`.
- `onPaid` must be idempotent. It runs once per `reference` — your order
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
  the price from `amountFor` and both drop-ins render it above the
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

The install migration adds `openreceive_payments` and `openreceive_meta` to THIS
application's database. That is the whole persistence OpenReceive needs. It does
not replace your orders, users, or products, and you do not join them.

- **Find this app's models first.** They may be named `Order`, `Invoice`,
  `Booking`, `Product`, `Variant`, `User`, `Account` — anything. Wire the hooks
  to those. Do not generate a parallel `ShopOrder` / `ShopProduct` / `ShopUser`
  stack.
- **The payable row's id is the `reference`.** Create it before checkout, keep
  it across retries, never reuse it. Pass that id to `<openreceive-checkout>`. A
  fresh id per page load lets one order be paid twice.
- **Products (or the catalog) are the price authority.** Order creation reads
  live prices into the order (snapshot line items if this app has them).
  `amountFor` reads only that order — never a payer-supplied amount, never a
  live catalog lookup that could re-price a cart already placed. Return
  `['currency' => …, 'value' => …]` with `value` a decimal STRING, plus a
  `description` of what they are buying.
- **Users own the order; OpenReceive never sees them.** `authorize` uses the
  same ownership check this app already uses on the order show / pay page —
  `$request->user()`, a policy, a session key, an encrypted cookie, whatever
  it is. `$context->reference()` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The engine refuses a new checkout under a reference that already
  settled (409).
- **Do not model `openreceive_payments`.** No Eloquent model, no `hasMany`, no
  `belongsTo`, no foreign key either direction. `reference` is not unique (many
  attempts per order). Fulfillment is a guarded transition on YOUR order row
  inside `onPaid` — `Order::where(...)->where('state', 'awaiting_payment')->update(...)`
  (or this app's equivalent), with no `DB::transaction()` of your own around it.
  Database writes only in the hook; emails, jobs, and broadcasts after commit
  (implement `OpenReceive\Hosts\AfterPaid` for those).

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
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-laravel.

## Laravel quickstart

Requires PHP ≥ 8.2 (64-bit) and Laravel ≥ 11 (12 current). Extensions:
`ext-gmp` is REQUIRED — the NWC transport's elliptic-curve math depends on it
— plus `sodium`, `mbstring` and the `pdo_*` driver for your database
(`pdo_pgsql`, `pdo_mysql` or `pdo_sqlite`). `php -m` lists what your build
has; on Debian/Ubuntu it is `apt-get install php8.2-gmp`, in the official
Docker image `docker-php-ext-install gmp`.

Add the Laravel package:

```sh
composer require openreceive/laravel
```

That is the whole install: `openreceive/laravel` depends on
`openreceive/openreceive`, the engine, so the default wallet client — built from
`NWC_URI` — works with nothing else added, and package discovery registers the
service provider. Hosts that bring their own NWC client bind
`OpenReceive\Nwc\ReceiveNwcClient` in the container instead.

Then run:

```sh
php artisan openreceive:install
php artisan migrate
```

`openreceive:install` writes three files:

- `config/openreceive.php` — the settings. The host hook is a CLASS NAME, not
  a closure, because `php artisan config:cache` serializes this file and a
  closure anywhere in it fails the cache;
- `app/OpenReceive/Host.php` — the three hooks (`authorize`, `amountFor`,
  `onPaid`), with the two generated placeholders wired and the fulfillment
  note as comments;
- `database/migrations/*_create_openreceive_tables.php` — one migration for
  both engine tables (`openreceive_payments` and `openreceive_meta`). Its DDL
  comes from the engine's `PaymentsSchema::statements()` for your connection's
  driver — PostgreSQL, MySQL/MariaDB and SQLite — and `php artisan migrate` runs
  it like any migration of your own; there is no second runner.

→ [OpenReceive\Storage](https://openreceive.org/guides/api-reference.md#openreceivestorage)

There is no Eloquent model for the engine's tables, and you do not write one.
The engine owns the table's commit locking, write-once settlement, and
reconciliation state machine. `reference` is indexed but not unique (a
reference may have many historical attempts); `payment_hash` is globally unique.

#### Fulfill exactly once

Within OpenReceive's own settlement paths, `onPaid` runs at most once per
reference: a second payment to a second invoice is recorded with
`status_reason = "duplicate_settlement"` and never fulfills again.

The one thing you own: **if anything other than OpenReceive can also fulfill
an order** — an admin action, a second payment processor, a replayed job —
those paths race each other, and `onPaid` must be idempotent. The generated
`Host.php` spells this out and shows the guarded transition:

```php
public function onPaid(PaymentSettlement $settlement): void
{
    $claimed = Order::where('id', $settlement->reference)
        ->where('state', 'awaiting_payment')
        ->update(['state' => 'paid', 'paid_at' => Carbon::createFromTimestampUTC($settlement->paidAt)]);
    if ($claimed === 0) {
        return; // someone else already fulfilled it
    }
    // The 'paid' state IS the flag. Ship the goods and send the mail from a job
    // that drains it after commit, or from afterPaid() below — never from here.
}
```

Delivery is at-least-once: `onPaid` runs inside the settlement transaction,
and an exception rolls it back for the next pass to retry. Keep it to database
writes on the order — an email or webhook sent from here would survive the
rollback and go out again. The `'paid'` transition above is the flag; let your
own job drain it after commit, or implement `OpenReceive\Hosts\AfterPaid`:
its `afterPaid(PaymentSettlement $settlement)` runs after COMMIT, best-effort,
for the same first settled attempt — the place for `FulfillOrder::dispatch(…)`
or an event. And open no `DB::transaction()` of your own inside `onPaid`: the
engine already holds the transaction on this connection, and PDO refuses a
nested `BEGIN`.

**A query-builder `update()` fires no model events.** That is the point — it is
one conditional `UPDATE`, so the claim is atomic and there is no model code
between the check and the write. It also means no observer, no `saved` event
and no `Model::updated` listener runs, which is fine for a job draining the
flag and useless for a model that owns the transition through events. If yours
does, take a row lock for the duration instead:

```php
public function onPaid(PaymentSettlement $settlement): void
{
    $order = Order::lockForUpdate()->find($settlement->reference);   // SELECT … FOR UPDATE
    if ($order === null || $order->state !== 'awaiting_payment') {
        return;
    }
    $order->update(['state' => 'paid', 'paid_at' => Carbon::createFromTimestampUTC($settlement->paidAt)]);  // events fire
}
```

**Unlocking a download works the same way.** If what the payer bought is a
file, do not unlock it in the browser: gate the download route on the paid
order row — `Order::where('id', $id)->where('user_id', $request->user()->id)->where('state', 'paid')->firstOrFail()`
or a 404 — and serve the file only then. The `'paid'` written above is the
unlock; the client never decides an order was fulfilled, it re-reads the row.
Buy a Button's `ShopController::download` is this in twenty lines.

Both shapes are idempotent, and both are correct. They differ only in whether
your model layer gets to run: the query-builder `update()` skips it and is the
right default; the row lock holds the row for the duration of the method and
is what you want when the transition has to go through your model. The
generated fulfillment note says the same thing — if your fulfillment is a
read-modify-write that cannot be expressed as one conditional `UPDATE`, take
the lock.

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
(`examples/buttons/server/laravel`).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

### Add wallet credentials

Laravel loads `.env` itself, and `config/openreceive.php` reads the values
through `env()`:

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

Under `php artisan config:cache` Laravel never reads `.env` at runtime — the
values are captured when you cache, as for every other Laravel secret — so
re-run `config:cache` after changing one. The engine redacts connection
strings in every log line, and `php artisan openreceive:doctor` prints each
variable as set/unset only.
→ [Environment variables](https://openreceive.org/guides/environment-variables.md).

### Configure the host hooks

`app/OpenReceive/Host.php` needs three things: authorization, the trusted
price, and fulfillment. All three receive the `reference` — a string you
choose, and the fulfillment identity: your order id, one per thing you
fulfill, created before checkout, kept across retries, never reused.
OpenReceive never looks inside it, but `onPaid` runs once per reference, a new
checkout under a reference that already settled is refused with 409, and a
fresh id per page load lets one order be paid twice.

```php
<?php

namespace App\OpenReceive;

use App\Models\Order;                      // YOUR model — it could be named anything.
use Carbon\Carbon;
use OpenReceive\Host as OpenReceiveHost;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;

final class Host implements OpenReceiveHost
{
    // Your policy, called before every checkout/payment/swap request.
    //   $context->action    — "checkout.prepare", "checkout.create", "payment.check",
    //                         "swap.quote", "swap.create", "swap.read" or "swap.refund"
    //   $context->request   — the Illuminate\Http\Request: read the session, the
    //                         authenticated user, cookies or headers, as in a controller
    //   $context->resource  — ['reference' => …, 'payment_hash' => ?] copied from the
    //                         payer's JSON body. It names an order; it does not prove
    //                         this caller owns it. reference is always a validated
    //                         non-empty string (≤200 chars); payment_hash is null except
    //                         on payment.check / swap.read / swap.refund.
    // Return true to allow, false for a 403. Here: only the signed-in customer
    // who placed the order may act on it.
    public function authorize(AuthorizeContext $context): bool
    {
        $order = Order::find($context->reference());
        return $order !== null && $order->user_id === $context->request->user()?->id;
    }

    // The price for a reference — here, your order id — from your own data; null
    // when there is nothing to pay for (a 404). `value` is a decimal STRING from
    // the order row, never a float and never a request param. `description` is
    // what the payer is buying, in your own words.
    public function amountFor(string $reference): ?array
    {
        $order = Order::find($reference);
        return $order === null ? null : [
            'currency' => 'USD',
            'value' => $order->total,                       // a decimal string column
            'description' => $order->items()->count().' items',
        ];
    }

    // Runs inside the settlement transaction, only for the order's first settled
    // attempt. The WHERE clause is the lock: a second fulfillment path of yours
    // (admin action, replayed job) updates zero rows and does nothing. Plain
    // Eloquent on the default connection, because the engine holds the
    // transaction on that connection's PDO — the query joins it.
    public function onPaid(PaymentSettlement $settlement): void
    {
        Order::where('id', $settlement->reference)
            ->where('state', 'awaiting_payment')
            ->update(['state' => 'paid', 'paid_at' => Carbon::createFromTimestampUTC($settlement->paidAt)]);
    }
}
```

`config/openreceive.php` names that class (`'host' => App\OpenReceive\Host::class`)
and the provider resolves it from the container, so it may take constructor
dependencies. `onPaid` runs inside the settlement transaction, only for the
first settled attempt for a reference.
→ [OpenReceive\Host](https://openreceive.org/guides/api-reference.md#openreceivehost) ·
[the authorize context](https://openreceive.org/guides/api-reference.md#the-authorize-context-php)

The routes mount under `config('openreceive.route_prefix')` (`openreceive`) and
`config('openreceive.middleware')` (`['web']`). The `web` group is how the
engine picks up your application's session and CSRF protection: Laravel's
`VerifyCsrfToken` reads `X-CSRF-TOKEN`, and the checkout client sends it from
`<meta name="csrf-token" content="{{ csrf_token() }}">` automatically — keep
that tag in the layout that renders the checkout. The same group brings every
middleware it carries; a global `auth` redirect on the `web` group would send
the engine's JSON routes to a login page too, so keep such guards on your own
route groups, not on `web` itself.

The generated `Host.php` ships `use LoggingOnPaid;` — a placeholder that only
logs the settlement and fulfills nothing. Replace it with your real fulfillment
(as above); the engine warns every time your application boots while the
placeholder is still there, because orders would otherwise be recorded as
settled without ever being fulfilled. The same applies to `use
AllowAllAuthorize;`, the generated allow-all placeholder: it treats
possession of the reference as authorization, which is safe only while
references are unguessable, and the engine warns at boot until you replace it
with your own ownership check (as above). Replace both, not just `onPaid`.

The amount always comes from your own order record; payer-supplied amounts are
rejected. The engine's `PaymentRepository` interface remains the escape hatch
for custom-storage applications and is not part of the quickstart.

For public web shops, opt into the per-IP invoice cap with
`'rate_limiting' => true`; leave it off (the default) when many payers share
one IP. The client IP is `$request->ip()`, so Laravel's `TrustProxies` decides
who the payer is behind a proxy. → [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

In production the engine builds the wallet client — and runs its receive-only
preflight — eagerly when your application boots, so a missing `NWC_URI`, a
dead relay, or a spend-capable wallet stops the deploy instead of surfacing as
customer-facing 500s on the first checkout. Outside production (tests,
consoles) the client is built lazily so no live wallet is needed.

PHP builds the whole engine again on every request, so that same preflight
would run per request under PHP-FPM or Apache; the package remembers the
wallet's info event in your default cache store for
`config('openreceive.wallet_info_cache_seconds')` (600) so a checkout request
costs one relay round trip, not two.

### Render the checkout

The engine serves JSON checkout routes only — rendering is your view. Any
OpenReceive frontend package works against the `/openreceive` mount; the
smallest is the custom element (its default `prefix` is already
`/openreceive`, and the package ships a self-contained `styles.css`; it is
scoped to what OpenReceive renders, so it sits safely next to any CSS
framework in any order). Laravel ships Vite, so the package installs like any
other frontend dependency:

```sh
npm install @openreceive/elements
```

```js
// resources/js/app.js — in the entry @vite() already loads
import { defineElements } from "@openreceive/elements";
import "@openreceive/elements/styles.css";

// Registers the <openreceive-checkout> tag with the browser. Without this,
// the tag in the Blade below is unknown markup and renders as nothing; with
// it, the element wakes up wherever the tag appears. Call once per page —
// order relative to the markup does not matter.
defineElements();
```

```blade
{{-- resources/views/orders/pay.blade.php --}}
<openreceive-checkout reference="{{ $order->id }}"></openreceive-checkout>
```

The element creates the checkout for `reference`, then renders and polls
itself. React/Vue/Svelte/Angular apps use the matching wrapper package instead
— same props and defaults ([Frontend checkout](https://openreceive.org/guides/frontend-checkout.md)). Build a
custom checkout only if this app cannot use a drop-in; then
`@openreceive/browser/headless` is the API
([Headless checkout](https://openreceive.org/guides/headless-checkout.md)).

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

**No npm in this project?** Every GitHub release attaches
`standalone-checkout-<version>.tar.gz`: one self-registering ESM file, its
stylesheet and a `MANIFEST.json` of hashes. Unpack it into
`public/openreceive/` and the same element needs two tags:

```blade
<link rel="stylesheet" href="/openreceive/openreceive-checkout.css" />
<script type="module" src="/openreceive/openreceive-checkout.js"></script>

<openreceive-checkout reference="{{ $order->id }}"></openreceive-checkout>
```

`MANIFEST.json` carries the version and a SHA-256 per file; keep the tarball
version in step with the Composer package.

### Reconciliation

Settlement runs on the request path. You do not need a cron job. Disable or
tune it with `'opportunistic_reconcile'` (`false`, or
`['min_interval_seconds' => …]`).

Optionally, run one worker so settlement does not wait for the next page
load:

```sh
php artisan openreceive:notifications
```

It listens for the wallet's NWC-02 `payment_received` notifications and runs
a periodic reconcile pass in the same process — one per deployment, not per
web instance. `php artisan openreceive:reconcile` is the one-shot pass if you
want to drive one yourself, and `php artisan openreceive:doctor` reports every
credential as set/unset, the host and its placeholders, the route mount and
the wallet preflight.

### Swap secrets

The package recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP` using the
shared [Lightning Swap Connect](https://openreceive.org/guides/lightning-swap-connect.md) vectors: setting either one
auto-builds the matching provider, so an app that wants swaps only supplies the
connection strings ([Environment variables](https://openreceive.org/guides/environment-variables.md)). The
`openreceive.swap_providers` container binding is the override knob — bind a
list of your own adapters to replace the auto-built set, or `[]` to disable
swaps.

One `openreceive_payments` row holds at most one provider order in its
server-only `swap_data`. The engine never returns `swap_data` from its routes
or writes it to a log. Do not select it into your own API, serialize it, or
log it; it may contain a provider credential.

**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late, which leaves it `refund_required` at the provider with
only your UI able to claim it — and the payer claims it on a second visit,
after leaving your page for an address in another wallet. That needs a
per-order URL your app serves, a route that restores the order behind it, and
something that restores the ATTEMPT, since `/checkouts/prepare` returns none.
[Swap refunds](https://openreceive.org/guides/swap-refunds.md) is the whole of it; read it before you set
`LSC_URI_PRIMARY`.
