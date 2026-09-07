# Laravel quickstart

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

→ [OpenReceive\Storage](api-reference.md#openreceivestorage)

There is no Eloquent model for the engine's tables, and you do not write one.
The engine owns the table's commit locking, write-once settlement, and
reconciliation state machine. `reference` is indexed but not unique (a
reference may have many historical attempts); `payment_hash` is globally unique.

### Fulfill exactly once

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
([`examples/buttons/server/laravel`](../../examples/buttons/server/laravel)).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

## Add wallet credentials

Laravel loads `.env` itself, and `config/openreceive.php` reads the values
through `env()`:

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

Under `php artisan config:cache` Laravel never reads `.env` at runtime — the
values are captured when you cache, as for every other Laravel secret — so
re-run `config:cache` after changing one. The engine redacts connection
strings in every log line, and `php artisan openreceive:doctor` prints each
variable as set/unset only.
→ [Environment variables](environment-variables.md).

## Configure the host hooks

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
→ [OpenReceive\Host](api-reference.md#openreceivehost) ·
[the authorize context](api-reference.md#the-authorize-context-php)

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
who the payer is behind a proxy. → [Rate limiting](rate-limiting.md)

<!-- shared:begin eager-preflight -->
In production the engine builds the wallet client — and runs its receive-only
preflight — eagerly when your application boots, so a missing `NWC_URI`, a
dead relay, or a spend-capable wallet stops the deploy instead of surfacing as
customer-facing 500s on the first checkout. Outside production (tests,
consoles) the client is built lazily so no live wallet is needed.
<!-- shared:end eager-preflight -->

PHP builds the whole engine again on every request, so that same preflight
would run per request under PHP-FPM or Apache; the package remembers the
wallet's info event in your default cache store for
`config('openreceive.wallet_info_cache_seconds')` (600) so a checkout request
costs one relay round trip, not two.

## Render the checkout

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
— same props and defaults ([Frontend checkout](frontend-checkout.md)). Build a
custom checkout only if this app cannot use a drop-in; then
`@openreceive/browser/headless` is the API
([Headless checkout](headless-checkout.md)).

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can defer tutorial screenshots until first open; single-file builds
(including the standalone checkout) include them upfront. If your
Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

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

## Reconciliation

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

## Swap secrets

The package recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP` using the
shared [Lightning Swap Connect](lightning-swap-connect.md) vectors: setting either one
auto-builds the matching provider, so an app that wants swaps only supplies the
connection strings ([Environment variables](environment-variables.md)). The
`openreceive.swap_providers` container binding is the override knob — bind a
list of your own adapters to replace the auto-built set, or `[]` to disable
swaps.

One `openreceive_payments` row holds at most one provider order in its
server-only `swap_data`. The engine never returns `swap_data` from its routes
or writes it to a log. Do not select it into your own API, serialize it, or
log it; it may contain a provider credential.

<!-- shared:begin swap-refund-commitment -->
**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late, which leaves it `refund_required` at the provider with
only your UI able to claim it — and the payer claims it on a second visit,
after leaving your page for an address in another wallet. That needs a
per-order URL your app serves, a route that restores the order behind it, and
something that restores the ATTEMPT, since `/checkouts/prepare` returns none.
[Swap refunds](swap-refunds.md) is the whole of it; read it before you set
`LSC_URI_PRIMARY`.
<!-- shared:end swap-refund-commitment -->

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
