# OpenReceive agent directions (PHP)

These directions describe OpenReceive 0.4.6.

Add OpenReceive to a PHP application — the app you are already working in. You
do not need a copy of the OpenReceive source: the engine is on Packagist
(`openreceive/openreceive`), the checkout UI is a tarball on every GitHub
release, and the quickstart is appended to this file in full, so you can do the
whole integration without fetching anything. Prefer the published package and
the PSR-15 handler it ships — do not reimplement wallet RPC, settlement, or
pricing.

Do not clone the OpenReceive repository into this app, and do not copy a demo's
models (`shop_orders`, a signed-cookie visitor, a SQLite catalog) over tables
that already exist. Find this application's order, product, and user models —
whatever they are actually named — and map the three hooks onto those.

Keep this application's router, its session/authentication and its database.
The engine is framework-free: it wants a PDO handle, one object with three
methods, and a place in your front controller (or middleware stack) to dispatch
`/openreceive/*` to its PSR-15 handler. If this app runs Laravel, use the
`openreceive/laravel` adapter and its own directions instead of this page.
Reuse the app's existing session or cookie in `authorize` and the PDO it
already opens in `PdoConnection`.

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
`amountFor`, `onPaid` on one `OpenReceive\Host`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — check the environment before you write code

Do this before running `composer require` or editing files.

1. Look for `NWC_URI` in this app's server environment — `.env`, the process
   env, the web server's `SetEnv`/`fastcgi_param`, the deploy config, whatever
   this app already uses. If the app runs in a container the value is in none
   of those: ask the running process
   (`docker exec <container> printenv NWC_URI`), because finding the NAME in a
   compose file proves nothing about the value. Never print or echo the value
   itself; only report whether it is set. Check for `LSC_URI_PRIMARY` in the
   same pass.

   If OpenReceive is already installed here, `OpenReceive\Server\Doctor::report()`
   answers this whole step in one command — every credential as set/unset, the
   host class and which hooks are still placeholders, the mount, and the wallet
   preflight. It never prints a value. A plain host runs it from a `bin/doctor`
   script (the quickstart's step 6 is the whole script).
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
6. Check the PHP runtime: `php -m` must list `gmp`, `sodium`, `mbstring`,
   `json`, `pdo` and one PDO driver. `ext-gmp` is REQUIRED — the NWC
   transport signs every request with it — and `php:*-cli`/`-fpm` images do
   not ship it (`docker-php-ext-install gmp`). PHP must be ≥ 8.2 and 64-bit.
7. If OpenReceive is ALREADY installed here, check the installed
   `openreceive/openreceive` version (`composer show openreceive/openreceive`)
   and the unpacked checkout's `MANIFEST.json` against the release named at the
   top of this file. The two must match: the browser build and the engine are
   one release. Upgrade first — and if this app runs in containers, rebuild the
   images: `vendor/` is baked into the image, so an in-place `composer update`
   is undone by the next `compose up`.

Only then start the quickstart.

## Non-negotiables

The quickstart below has the code. These are the rules it cannot state for
itself, and they hold for every integration.

- OpenReceive never owns orders, users, prices, or fulfillment. The section
  below is how those tables sit next to the engine — not a second order model,
  and not a join to `openreceive_payments`.
- Keep `NWC_URI` / `LSC_URI_*` server-only. Never put them in browser code,
  logs, or assets — and never in a `config.php` that ships in the repository.
- The host owns the price. `amountFor` reads it from your own data; reject
  payer-supplied amounts.
- `authorize` runs on every request, and the `resource` it receives is a CLAIM
  the payer made, not proof. Read this app's session or signed cookie from the
  PSR-7 request; never trust a body field. The `Hosts\AllowAllAuthorize` trait
  is a placeholder that allows everything (the engine warns at boot while a
  host uses it) — replace it with this app's real ownership check, same as
  `onPaid`'s `Hosts\LoggingOnPaid`.
- `onPaid` must be idempotent. It runs once per `reference` — your order id, one
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
  server serves (`/checkout/:reference` — `resumable` on the element), your own
  order-summary route to restore the order from, and the ATTEMPT.
  `/checkouts/prepare` returns no attempts, so a checkout rebuilt from the
  reference alone opens on the method grid. Re-picking the same coin
  (`POST /swaps`) re-serves the committed attempt — but only while it is live,
  and the shadow invoice behind a swap lasts about half an hour, after which the
  same click mints a NEW deposit address and the refund is off-screen. Keep the
  `payment_hash` and reopen the attempt with `POST /swaps/status`, which has no
  such window. https://openreceive.org/guides/swap-refunds.md
- Show the payer WHAT THEY ARE BUYING. Return an optional `description` beside
  the price from `amountFor` and the drop-in renders it above the amount.
  Without it the checkout is a QR and "$1.00" with no sign of what the dollar
  is for.
- Show the payer the transaction record: `createTransactionDetails(...)` rows,
  collapsed behind a caret, on the live checkout AND on the receipt. A payment
  hash and a deposit txid are the only evidence a payer has that they paid you.
  `<openreceive-checkout>` already renders this panel and the `description` —
  these two rules cost you code only on a custom UI or your own receipt page,
  never a reason to replace the drop-in. (It returns no rows while the rail is
  `checkout_lock` — before the payer has chosen anything there is no
  transaction — so render the caret only when the rows are non-empty.)
- HTTP JSON is snake_case; the PHP API uses camelCase methods over snake_case
  array keys, and the browser packages' TypeScript APIs are camelCase.
- Money is integers or decimal strings — never binary floats. `amountFor`
  returns `'value' => '12.00'`, a string; never `12.00`.
- PHP starts every request from nothing. The engine is built for that — the
  settlement gate is a row in `openreceive_meta`, not process memory — so do
  not add a cache, a static, or an APCu entry to "remember" the wallet or a
  reconcile timer between requests.

## Your tables, not ours

`PaymentsSchema::statements($dialect)` renders `openreceive_payments` and
`openreceive_meta` for THIS application's database; run it through the app's
own migration tool. That is the whole persistence OpenReceive needs. It does
not replace your orders, users, or products, and you do not join them.

- **Find this app's models first.** They may be named `Order`, `Invoice`,
  `Booking`, `Product`, `Variant`, `User`, `Account` — anything. Wire the hooks
  to those. Do not generate a parallel `ShopOrder` / `ShopProduct` / `ShopUser`
  stack.
- **The payable row's id is the `reference`.** Create it before checkout, keep
  it across retries, never reuse it. Pass that id to `<openreceive-checkout>`.
  A fresh id per page load lets one order be paid twice.
- **Products (or the catalog) are the price authority.** Order creation reads
  live prices into the order (snapshot line items if this app has them).
  `amountFor` reads only that order — never a payer-supplied amount, never a
  live catalog lookup that could re-price a cart already placed. Return
  `['currency' => …, 'value' => …]` as a decimal STRING, plus a `description`
  of what they are buying.
- **Users own the order; OpenReceive never sees them.** `authorize` uses the
  same ownership check this app already uses on the order show / pay page —
  `$_SESSION['user_id']`, a signed cookie, a session library, whatever it is —
  read from `$context->request` (the PSR-7 server request).
  `$context->reference()` is a claim the payer sent, not proof.
- **The order is unpaid or paid.** Do not copy `pending` / `expired` / `failed`
  / `attention` onto it. Those are attempt statuses on `openreceive_payments`. An
  expired invoice does not cancel the order; a later checkout may mint another
  attempt. The engine refuses a new checkout under a reference that already
  settled (409).
- **Pass this app's PDO.** `new SqlPaymentRepository(new PdoConnection($pdo))`
  over the connection the app already opens; do not implement
  `PaymentRepository` unless no PDO can reach this database. `reference` is not
  unique (many attempts per order). Fulfillment is a guarded transition on YOUR
  order row inside `onPaid` — `UPDATE … WHERE state = 'awaiting_payment'` (or
  this app's equivalent) through `$settlement->connection->execute()`, on that
  same settlement transaction, not a second `PDO`. Database writes only in the
  hook; emails, jobs and webhooks after commit — implement `Hosts\AfterPaid`
  for those. Placeholders are positional `?` on every dialect.

## If you build your own checkout UI

The drop-in (`<openreceive-checkout>`, from the release's standalone tarball or
`@openreceive/elements`) already obeys all of this. This list is the short form
of https://openreceive.org/guides/checkout-ux.md, for a UI built on
`@openreceive/browser/headless`. Read that before writing components.

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

## More documentation

Fetch one when the moment comes. Each is raw markdown, so a plain GET is
enough; drop the `.md` for the same page a person would read.

- https://openreceive.org/guides/authorization.md — before you write `authorize`
- https://openreceive.org/guides/environment-variables.md — every variable, and what is deliberately not one
- https://openreceive.org/guides/storage.md — the payment tables and the attempt state machine
- https://openreceive.org/guides/frontend-checkout.md — the drop-in's attributes and slots, and the standalone build
- https://openreceive.org/guides/checkout-ux.md — read before building any custom UI
- https://openreceive.org/guides/headless-checkout.md — the controller, the display models, refunds
- https://openreceive.org/guides/provider-registry.md — where the wallet logos and pay
  tutorials come from: inside the JavaScript, nothing to serve. This is the page
  that owns the image rule, not the summary in checkout-ux.md
- https://openreceive.org/guides/automated-swaps.md — only if `LSC_URI_PRIMARY` is set
- https://openreceive.org/guides/swap-refunds.md — the refund flow, and the route back to it. Read it before you turn swaps on
- https://openreceive.org/guides/lightning-swap-connect.md — what an `LSC_URI_*` code actually is
- https://openreceive.org/guides/price-feeds.md — where the fiat→sats rate comes from, and how to replace it
- https://openreceive.org/guides/host-testing.md — testing your three hooks without a live wallet or provider (`OpenReceive\Testing`)
- https://openreceive.org/guides/rate-limiting.md — before a public shop goes live
- https://openreceive.org/guides/security.md and https://openreceive.org/guides/deploying.md — before this goes anywhere real
- https://openreceive.org/guides/api-reference.md — every route, option and error code; the PHP section names every class above
- https://openreceive.org/guides/custom-checkout-route.md — advanced: replacing the shipped handler's routes with your own
- https://openreceive.org/guides/react-material-ui-recipe.md — a worked custom UI on a component library
- https://openreceive.org/guides.md — the index, if what you need is not above

Questions, or a problem with the library itself:
https://openreceive.org/contact

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-php.

## PHP quickstart (plain PHP)

Plain PHP, no framework. Requires PHP ≥ 8.2 (64-bit) with `ext-gmp`, `ext-sodium`,
`ext-mbstring`, `ext-json`, `ext-pdo` and one PDO driver (`pdo_pgsql`,
`pdo_sqlite` or `pdo_mysql`). `ext-gmp` is **required**, not optional: the NWC
transport signs every wallet request with it. Laravel has its own quickstart
(`openreceive/laravel`, the thin adapter over this engine); this page is the
one for a host with no framework at all — a front controller, a PDO handle and
three methods.

### 1. Install

```sh
composer require openreceive/openreceive nyholm/psr7 nyholm/psr7-server
```

`openreceive/openreceive` is the whole engine: the receive-only wallet client,
exact money, settlement, the `openreceive_payments` repository over PDO, swaps,
rates and a PSR-15 handler. It depends on the PSR interfaces only, so bring the
PSR-7/PSR-17 implementation your app already has; `nyholm/psr7` +
`nyholm/psr7-server` is the smallest pair and the one this page uses.

The **checkout UI is not in the Composer package.** Packagist installs from git
and cannot run a JS build, so the browser side ships separately as
`standalone-checkout-<version>.tar.gz` on every
[GitHub release](https://github.com/openreceive/openreceive/releases) — one
self-contained ES module, its stylesheet, a source map and a
`MANIFEST.json`. Unpack it somewhere your web server serves as static files
(step 5). A host with a JS bundler can `npm install @openreceive/elements`
instead; the tarball is the same build.

### 2. Migrate the payment tables

The engine owns two tables in **your** database and renders their DDL per
dialect. Run it through whatever your application uses for schema changes —
Phinx, Doctrine Migrations, a plain SQL file, a `bin/migrate` script:

```php
use OpenReceive\Storage\PaymentsSchema;

// $dialect is 'pgsql', 'mysql' or 'sqlite' (PDO::ATTR_DRIVER_NAME gives it to you).
foreach (PaymentsSchema::statements($dialect) as $sql) {
    $pdo->exec($sql);
}
// down(): PaymentsSchema::dropStatements()
```

`PaymentsSchema::migrate(new PdoConnection($pdo))` does the same in one call
for a script that has no migration tool. It creates `openreceive_payments`
(one row per payment attempt) and `openreceive_meta` (the reconcile gate and
the schema version); leave both to the library. Details:
[Payment storage](https://openreceive.org/guides/storage.md).

### 3. Add wallet credentials

Create a server-only `.env` (or export the variables from your process
manager — the engine reads `getenv()` and `$_ENV`):

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

Nothing in PHP loads a `.env` file on its own; `vlucas/phpdotenv`, your web
server's `SetEnv`/`fastcgi_param`, or the container runtime has to put the
values in the process environment first
([Environment variables](https://openreceive.org/guides/environment-variables.md)).

### 4. Wire OpenReceive

Three methods on one object are the entire bridge between the engine and your
data; the engine never sees an order, a user or a price except through them.
Then `Engine` composes the wallet, the repository over your PDO and that
object into a PSR-15 handler, which your front controller dispatches to under
one path prefix:

```php
<?php
// public/index.php — or wherever your front controller lives
declare(strict_types=1);

use Nyholm\Psr7\Factory\Psr17Factory;
use Nyholm\Psr7Server\ServerRequestCreator;
use OpenReceive\Host;
use OpenReceive\PaymentSettlement;
use OpenReceive\Server\AuthorizeContext;
use OpenReceive\Server\Engine;
use OpenReceive\Server\Service;
use OpenReceive\Storage\PdoConnection;
use OpenReceive\Storage\SqlPaymentRepository;

require __DIR__ . '/../vendor/autoload.php';

$pdo = new PDO(getenv('DATABASE_DSN'));        // the PDO your app already opens
$orders = new App\Orders($pdo);                // YOUR order model — any name works

$host = new class($orders) implements Host {
    public function __construct(private readonly App\Orders $orders) {}

    // Your own access check: may this caller do this action to this reference?
    // `$context->reference()` is your order id, sent back by the payer's
    // browser — a claim, not proof — already validated as a non-empty string.
    // `$context->request` is the PSR-7 ServerRequest: read your session or
    // cookie from it. `$context->action` names the route (checkout.create, …).
    public function authorize(AuthorizeContext $context): bool
    {
        $order = $this->orders->find($context->reference());
        return $order !== null && $order->userId === App\Session::userId($context->request);
    }

    // The price for a reference from YOUR data. `value` is a decimal STRING,
    // never a float and never a request parameter; `description` is what the
    // payer is buying, rendered above the amount. null = nothing to pay (404).
    public function amountFor(string $reference): ?array
    {
        $order = $this->orders->find($reference);
        return $order === null ? null : [
            'currency' => 'USD',
            'value' => $order->total,               // "12.00"
            'description' => "{$order->lineCount} items",
        ];
    }

    // INSIDE the settlement transaction, once per reference. Write through
    // `$settlement->connection` — that transaction — so your order flips in the
    // same commit as the payment record. The WHERE clause is the lock: a second
    // fulfillment path of yours updates zero rows. Database writes only here;
    // emails and webhooks go after commit (implement Hosts\AfterPaid for that).
    public function onPaid(PaymentSettlement $settlement): void
    {
        $settlement->connection->execute(
            "UPDATE orders SET state = 'paid', paid_at = ? WHERE id = ? AND state = 'awaiting_payment'",
            [$settlement->paidAt, $settlement->reference],
        );
    }
};

$engine = new Engine(
    $host,
    new SqlPaymentRepository(new PdoConnection($pdo)),
    Service::fromEnvironment(),                    // NWC_URI (+ LSC_URI_*) from the environment; preflight runs here
    prefix: '/openreceive',
);

$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
if (str_starts_with($path, '/openreceive')) {
    $factory = new Psr17Factory();
    $request = (new ServerRequestCreator($factory, $factory, $factory, $factory))->fromGlobals();
    $response = $engine->psr15Handler()->handle($request);
    http_response_code($response->getStatusCode());
    foreach ($response->getHeaders() as $name => $values) {
        foreach ($values as $value) header("{$name}: {$value}", false);
    }
    echo $response->getBody();
    return;
}
// … your own routes
```

`Service::fromEnvironment()` builds the wallet client from `NWC_URI` and runs
the receive-only preflight — a missing, invalid or spend-capable code throws
before any route is served. PHP starts every request from nothing, so that
check runs per request that reaches the engine; the settlement gate the
engine relies on lives in `openreceive_meta`, not in memory, which is why a
fleet of PHP-FPM workers shares one wallet-scan budget with no worker of its
own. Later OpenReceive requests also settle pending invoices, so a payer who
closes the tab is still covered. `authorize` runs on every request.
→ [Engine](https://openreceive.org/guides/api-reference.md#openreceiveserverengine) ·
[Host](https://openreceive.org/guides/api-reference.md#openreceivehost) ·
[the authorize context](https://openreceive.org/guides/api-reference.md#the-authorize-context-php)

**Cross-site requests.** Plain PHP has no CSRF layer, exactly like Express, and
the engine does not need one: every mounted route refuses a request whose
`Sec-Fetch-Site` header says `cross-site`, so a form or script on another
origin cannot mint invoices with a payer's cookie. `<meta name="csrf-token">`
is therefore optional — set it and the checkout sends the value back as
`X-CSRF-Token` (or the header named by `csrf-header`) for your own layer to
check. What the engine's check does NOT cover: a browser too old to send
`Sec-Fetch-Site` (the header is absent, and absent passes), and anything that
is not a browser at all — a script holding a stolen cookie is a session
problem, not a forgery problem. `authorize` is still the boundary that decides
whether *this caller* may act on *this order* ([Security](https://openreceive.org/guides/security.md)).

For public web shops, opt into the per-IP invoice cap with
`rateLimiting: true` on `Engine`; leave it off (the default) when many payers
share one IP. Behind a proxy pass `clientIp: fn ($request) => …` so the cap
counts the payer, not the proxy. → [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

Your app also needs an ordinary order-creation route that validates the cart,
prices with exact decimal math, and returns the order id the page will pass as
the `reference`. OpenReceive never prices from payer input. The `reference` is
a string you choose, and it is the fulfillment identity: your order id — one
per thing you fulfill, created before checkout, kept across retries, never
reused. `onPaid` runs once per reference, a new checkout under a reference
that already settled is refused with 409, and a fresh id per page load lets
one order be paid twice.

Naming boundary: PHP APIs use camelCase methods and snake_case array keys
(`amount_msats`, `payment_hash`), matching the wire — the mounted HTTP routes
and the browser snapshots are snake_case throughout.

### 5. Render checkout

Unpack the release's `standalone-checkout-<version>.tar.gz` into a directory
your web server serves — `public/openreceive/` here — and add two tags plus
the element:

```html
<link rel="stylesheet" href="/openreceive/openreceive-checkout.css" />
<script type="module" src="/openreceive/openreceive-checkout.js"></script>

<openreceive-checkout
  reference="<?= htmlspecialchars($order->id) ?>"
  prefix="/openreceive"
></openreceive-checkout>
```

The module registers `<openreceive-checkout>` as it loads; the element creates
the checkout for `reference`, then renders, polls and settles itself. The
stylesheet is scoped to what OpenReceive renders, so it sits safely next to
any CSS framework. The checkout follows the payer's theme; on a page that is
always one theme, lock it with `theme="dark"`. React/Vue/Svelte/Angular apps
use the matching wrapper package instead — same attributes
([Frontend checkout](https://openreceive.org/guides/frontend-checkout.md)); a custom UI builds on
`@openreceive/browser/headless` ([Headless checkout](https://openreceive.org/guides/headless-checkout.md)).

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can defer tutorial screenshots until first open; single-file builds
(including the standalone checkout) include them upfront. If your
Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](https://openreceive.org/guides/provider-registry.md#assets)).

`MANIFEST.json` in the tarball carries the version and a SHA-256 per file, so a
copied tree can be checked against the release it came from; keep the tarball
version in step with the Composer package.

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
(`examples/buttons/server/php-plain`).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

### 6. Verify

```php
foreach (\OpenReceive\Server\Doctor::report(
    \OpenReceive\Server\Service::processEnvironment(),
    $host,
    static fn () => \OpenReceive\Server\Service::fromEnvironment(),
    '/openreceive',
) as $line) echo $line, PHP_EOL;
```

`Doctor::report()` prints every credential as set/unset (never a value), the
host class and which of the three methods are still the scaffolded
placeholders (`Hosts\AllowAllAuthorize`, `Hosts\LoggingOnPaid` — the engine
also warns at boot while either is in use), where the handler is mounted, and
the receive-only wallet preflight. `$engine->doctor()` is the same report for
an engine you already built. Put it behind a `bin/doctor` script; the demo's
is twelve lines. → [Doctor](https://openreceive.org/guides/api-reference.md#openreceiveserverdoctor)

Then open the checkout in a browser, confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, inspect the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

### Reconciliation

Settlement runs on the request path: every payment route first runs one
bounded reconcile pass through the durable `openreceive_meta` gate (minimum 2
seconds between real wallet scans, shared by every PHP process). You do not
need a cron job. Tune or disable it with `Engine`'s `opportunisticReconcile`
(`false`, or `['min_interval_seconds' => …]`).

Optionally, run one worker so settlement does not wait for the next page load:

```php
$engine->notificationsWorker()->run();   // blocks: an NWC-02 listener plus a periodic pass
```

as its own long-lived process (`php bin/notifications`). `$engine->reconcile()`
is the one-shot pass if you want to drive it yourself.
→ [Engine notificationsWorker](https://openreceive.org/guides/api-reference.md#engine-notificationsworker)

### Swap secrets

Setting `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP`) auto-builds the matching
swap providers; nothing in your code changes. One `openreceive_payments` row
holds at most one provider order in its server-only `swap_data`; the
repository never selects it into public arrays — do not log it or return it
from your own API. **Setting either connection string commits you to
refunds**: a deposit that arrives short or late is claimed on a second visit,
which needs a per-order URL your app serves and the attempt's `payment_hash`
kept. [Swap refunds](https://openreceive.org/guides/swap-refunds.md) is the whole of it; read it before you
set `LSC_URI_PRIMARY`.
