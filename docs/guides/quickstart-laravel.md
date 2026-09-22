# Laravel quickstart

Requires PHP ≥ 8.2 (64-bit) and Laravel ≥ 11 (12 current). You also need these
PHP extensions:

- `ext-gmp`, which is REQUIRED. The NWC transport's elliptic-curve math depends
  on it.
- `sodium` and `mbstring`.
- The `pdo_*` driver for your database (`pdo_pgsql`, `pdo_mysql` or
  `pdo_sqlite`).

`php -m` lists what your build has. To add gmp on Debian/Ubuntu, run
`apt-get install php8.2-gmp`. In the official Docker image, run
`docker-php-ext-install gmp`.

Add the Laravel package:

```sh
composer require openreceive/laravel
```

That is the whole install. `openreceive/laravel` depends on
`openreceive/openreceive`, the engine. So the default wallet client works with
nothing else added. It is built from `NWC_URI`. Package discovery registers the
service provider. If your app brings its own NWC client, bind
`OpenReceive\Nwc\ReceiveNwcClient` in the container instead.

Then run:

```sh
php artisan openreceive:install
php artisan migrate
```

`openreceive:install` writes three files:

- `config/openreceive.php`: the settings. The host hook is a CLASS NAME, not a
  closure. `php artisan config:cache` serializes this file, and a closure
  anywhere in it makes the cache fail.
- `app/OpenReceive/Host.php`: the three hooks (`authorize`, `amountFor`,
  `onPaid`), with the two generated placeholders wired in and the fulfillment
  note as comments.
- `database/migrations/*_create_openreceive_tables.php`: one migration for both
  engine tables (`openreceive_payments` and `openreceive_meta`). Its DDL comes
  from the engine's `PaymentsSchema::statements()` for your connection's
  driver: PostgreSQL, MySQL/MariaDB or SQLite. `php artisan migrate` runs it
  like any of your own migrations. There is no second runner.

→ [OpenReceive\Storage](api-reference.md#openreceivestorage)

There is no Eloquent model for the engine's tables, and you do not write one.
The engine owns the table's commit locking, write-once settlement, and
reconciliation state machine. `reference` is indexed but not unique, because
one reference may have many historical attempts. `payment_hash` is globally
unique.

### Fulfill exactly once

Within OpenReceive's own settlement paths, `onPaid` runs at most once per
reference. A second payment to a second invoice is recorded with
`status_reason = "duplicate_settlement"` and never fulfills again.

One case is yours to handle. **If anything other than OpenReceive can also
fulfill an order**, such as an admin action, a second payment processor, or a
replayed job, those paths race each other. Then `onPaid` must be idempotent.
The generated `Host.php` explains this and shows the guarded transition:

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

Delivery is at-least-once. `onPaid` runs inside the settlement transaction. If
it throws, the transaction rolls back and the next pass retries. So keep
`onPaid` to database writes on the order. An email or webhook sent from here
would survive the rollback and go out again. The `'paid'` transition above is
the flag. Drain it after commit in one of two ways:

- Let your own job drain it.
- Implement `OpenReceive\Hosts\AfterPaid`. Its
  `afterPaid(PaymentSettlement $settlement)` runs after COMMIT, best-effort,
  for the same first settled attempt. Put `FulfillOrder::dispatch(…)` or an
  event there.

Do not open a `DB::transaction()` of your own inside `onPaid`. The engine
already holds the transaction on this connection, and PDO refuses a nested
`BEGIN`.

**A query-builder `update()` fires no model events.** That is intended. It
runs one conditional `UPDATE`, so the claim is atomic and no model code runs
between the check and the write. It also means no observer, no `saved` event
and no `Model::updated` listener runs. That is fine for a job that drains the
flag. It does not work for a model that owns the transition through events. If
yours does, take a row lock for the duration instead:

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

**Unlocking a download works the same way.** If the payer bought a file, do not
unlock it in the browser. Gate the download route on the paid order row, and
serve the file only if that row exists:
`Order::where('id', $id)->where('user_id', $request->user()->id)->where('state', 'paid')->firstOrFail()`,
or a 404 otherwise. The `'paid'` written above is the unlock. The client never
decides that an order was fulfilled. It re-reads the row. Buy a Button's
`ShopController::download` does this in twenty lines.

Both shapes are idempotent and correct. They differ only in whether your model
layer runs:

- The query-builder `update()` skips the model layer. It is the right default.
- The row lock holds the row for the duration of the method. Use it when the
  transition has to go through your model.

The generated fulfillment note says the same thing. If your fulfillment is a
read-modify-write that one conditional `UPDATE` cannot express, take the lock.

Buy a Button
([`examples/buttons/server/laravel`](../../examples/buttons/server/laravel))
is a runnable illustration of this boundary. It is not a template to copy
models from. It has products, visitors, and orders, and the three hooks are the
only bridge. Map that shape onto the models in THIS app.

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
   ([get one here](https://openreceive.org/get_a_nwc_code_to_receive_payments)).
   Put it in `NWC_URI`.
2. Optional: set up a [swap provider](https://openreceive.org/set_up_swap_provider).
   Put its connection string in `LSC_URI_PRIMARY`, and a second one in
   `LSC_URI_BACKUP` if you have one.

Never put these values in browser code. Your app refuses to start if the NWC
code also advertises spend methods such as `pay_invoice`. Create a
receive-only code instead ([Security](security.md)).
<!-- shared:end credentials -->

Under `php artisan config:cache`, Laravel never reads `.env` at runtime. The
values are captured when you cache, as with every other Laravel secret. So
re-run `config:cache` after changing one. The engine redacts connection
strings in every log line. `php artisan openreceive:doctor` prints each
variable only as set or unset.
→ [Environment variables](environment-variables.md).

## Configure the host hooks

`app/OpenReceive/Host.php` needs three things: authorization, the trusted
price, and fulfillment. All three receive the `reference`. This is a string you
choose, and it is the fulfillment identity. Use your order id:

- one per thing you fulfill,
- created before checkout,
- kept across retries,
- never reused.

OpenReceive never looks inside it. But `onPaid` commits fulfillment once per
reference, and a new checkout under a reference that already settled is
refused with 409. A fresh id per page load would let one order be paid twice.

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

`config/openreceive.php` names that class
(`'host' => App\OpenReceive\Host::class`). The provider resolves it from the
container, so it may take constructor dependencies. `onPaid` runs inside the
settlement transaction, only for the first settled attempt for a reference.
→ [OpenReceive\Host](api-reference.md#openreceivehost) ·
[the authorize context](api-reference.md#the-authorize-context-php)

The routes mount under `config('openreceive.route_prefix')` (`openreceive`),
with the middleware in `config('openreceive.middleware')` (`['web']`). The
`web` group is how the engine picks up your application's session and CSRF
protection. Laravel's `VerifyCsrfToken` reads `X-CSRF-TOKEN`. The checkout
client sends it automatically from
`<meta name="csrf-token" content="{{ csrf_token() }}">`, so keep that tag in
the layout that renders the checkout.

The `web` group also brings every middleware it carries. A global `auth`
redirect on the `web` group would send the engine's JSON routes to a login page
too. Keep such guards on your own route groups, not on `web` itself.

The generated `Host.php` ships two placeholders. Replace both, not just
`onPaid`:

- `use LoggingOnPaid;` only logs the settlement and fulfills nothing. Replace
  it with your real fulfillment (as above). Until you do, orders would be
  recorded as settled without ever being fulfilled, so the engine warns every
  time your application boots.
- `use AllowAllAuthorize;` allows everything. It treats possession of the
  reference as authorization, which is safe only while references are
  unguessable. The engine warns at boot until you replace it with your own
  ownership check (as above).

The amount always comes from your own order record. Payer-supplied amounts are
rejected. The engine's `PaymentRepository` interface remains the escape hatch
for apps with custom storage. It is not part of the quickstart.

For public web shops, turn on the per-IP invoice cap with
`'rate_limiting' => true`. Leave it off (the default) when many payers share
one IP. The client IP is `$request->ip()`, so behind a proxy Laravel's
`TrustProxies` decides who the payer is. → [Rate limiting](rate-limiting.md)

<!-- shared:begin eager-preflight -->
In production, the engine builds the wallet client when your app boots. It
also runs the receive-only preflight right away: it reaches the wallet and
checks that the code cannot spend. A missing `NWC_URI`, a dead relay, or a
spend-capable wallet then stops the deploy. Otherwise those problems would
show up as 500 errors for customers on the first checkout. Outside production
(tests, consoles), the engine builds the client lazily, on first use, so no
live wallet is needed.
<!-- shared:end eager-preflight -->

PHP builds the whole engine again on every request. Under PHP-FPM or Apache,
that same preflight would then run per request. To avoid that, the package
caches the wallet's info event in your default cache store for
`config('openreceive.wallet_info_cache_seconds')` (600). A checkout request
then costs one relay round trip, not two.

## Render the checkout

Serve the compiled `styles.css` without Tailwind processing. Either import it
from JavaScript (with a CSS-capable bundler) or use a plain
`<link rel="stylesheet">`. Do not `@import` it into your Tailwind entry. Its
rules have zero specificity, so your own styles can override checkout styles.
Scoping does not prevent that.

The engine serves JSON checkout routes only. Your view does the rendering. Any
OpenReceive frontend package works against the `/openreceive` mount. The
smallest is the custom element. Its default `prefix` is already
`/openreceive`. The package ships a self-contained `styles.css`, scoped to what
OpenReceive renders. Laravel ships Vite, so the package installs like any other
frontend dependency:

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
itself. React, Vue, Svelte, and Angular apps use the matching wrapper package
instead, with the same props and defaults
([Frontend checkout](frontend-checkout.md)). Build a custom checkout only if
this app cannot use a drop-in. In that case `@openreceive/browser/headless` is
the API ([Headless checkout](headless-checkout.md)).

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can load tutorial screenshots only when a tutorial is first opened.
Single-file builds, including the standalone checkout, include them upfront. If
your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

Then open the checkout in a browser. Confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, check the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

**No npm in this project?** Every GitHub release attaches
`standalone-checkout-<version>.tar.gz`. It holds one self-registering ESM file,
its stylesheet and a `MANIFEST.json` of hashes. Unpack it into
`public/openreceive/`, and the same element needs just two tags:

```blade
<link rel="stylesheet" href="/openreceive/openreceive-checkout.css" />
<script type="module" src="/openreceive/openreceive-checkout.js"></script>

<openreceive-checkout reference="{{ $order->id }}"></openreceive-checkout>
```

`MANIFEST.json` carries the version and a SHA-256 per file. Keep the tarball
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

The worker listens for the wallet's NWC-02 `payment_received` notifications.
The same process also runs a periodic reconcile pass. Run one per deployment,
not one per web instance.

Two more commands help:

- `php artisan openreceive:reconcile` runs one pass, if you want to drive it
  yourself.
- `php artisan openreceive:doctor` reports every credential as set or unset,
  the host and its placeholders, the route mount, and the wallet preflight.

## Swap secrets

The package recognizes `LSC_URI_PRIMARY` and `LSC_URI_BACKUP`, using the
shared [Lightning Swap Connect](lightning-swap-connect.md) vectors. Setting
either one auto-builds the matching provider. So an app that wants swaps only
supplies the connection strings
([Environment variables](environment-variables.md)). To override this, use the
`openreceive.swap_providers` container binding. Bind a list of your own
adapters to replace the auto-built set, or `[]` to disable swaps.

One `openreceive_payments` row holds at most one provider order, in its
server-only `swap_data`. The engine never returns `swap_data` from its routes
or writes it to a log. Do not select it into your own API, serialize it, or
log it. It may contain a provider credential.

<!-- shared:begin swap-refund-commitment -->
**Setting either connection string commits you to refunds.** A swap deposit can
arrive short or late. The provider then marks it `refund_required`, and only
your UI can claim it. The payer claims it on a second visit, after leaving your
page to get an address in another wallet. That needs three things:

- a per-order URL your app serves,
- a route that restores the order behind it,
- something that restores the ATTEMPT, since `/checkouts/prepare` returns none.

[Swap refunds](swap-refunds.md) covers all of it. Read it before you set
`LSC_URI_PRIMARY`.
<!-- shared:end swap-refund-commitment -->

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
