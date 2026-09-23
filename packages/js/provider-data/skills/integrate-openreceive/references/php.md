# OpenReceive agent directions (PHP)

These directions describe OpenReceive 0.4.11.

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
Lightning payment. Step 0 collects those credentials from the user; you write three hooks — `authorize`,
`amountFor`, `onPaid` on one `OpenReceive\Host`;
OpenReceive supplies invoices, polling, settlement and the checkout UI. It never
owns orders, users, prices, or fulfillment.

## Step 0 — ask for the two codes, one question at a time

Before anything else, look at one file: the project's `.env`, if it exists.
Read it only far enough to see whether `NWC_URI` and `LSC_URI_PRIMARY` are
there and non-empty, and never print the values. A code that is already
set is not asked for again; if both are set, skip to step 5
(making the server load the file), then the quickstart.

Otherwise your next action is a question to the user. Do not run `composer require`,
edit the app, write `.env.example`, or search anywhere else before asking
it. Do not read deploy config (compose files, `SetEnv`/`fastcgi_param` blocks, platform secrets), Docker containers, or process environments, and never run
`printenv`. A new shop has neither code yet: hunting for one burns the turn and
can leak other secrets into the transcript.

Two server-only URIs are needed before the quickstart:

- `NWC_URI` — a receive-only Nostr Wallet Connect code,
  `nostr+walletconnect://…`. Required for Bitcoin.
- `LSC_URI_PRIMARY` — a Lightning Swap Connect URI,
  `lightning+swapconnect://…`. Required for USDT, USDC, ETH and SOL. Skip it
  only when the user says they want Bitcoin alone.

The user never edits an environment file. They paste each code into the chat;
you store it. Ask one question per message.

1. **First message — the NWC code, and nothing else.** Ask for it and walk them
   through getting it:

   > To receive payments I need a receive-only wallet code. In Rizful: open
   > the menu, tap NWC, choose Receive-only NWC code, and tap Copy
   > (https://openreceive.org/get_a_nwc_code_to_receive_payments). If you would
   > rather run your own wallet, Alby Hub works too: Connections → Add
   > Connection → Read Only. Paste the code here and I will store it.

   Do not mention `.env`, exports, or "tell me when it's set".
2. **When they paste it.** If it does not start with `nostr+walletconnect://`,
   ask them to copy the receive-only code again. Otherwise write
   `NWC_URI=<paste>` into the project's `.env`, creating the file if needed.
   Make sure `.gitignore` covers `.env` (and `.dockerignore`, if the app has
   one). Never echo the value, commit it, or put it in client code. Reply only
   that it is saved, then ask the next question.
3. **Second message — swaps.** If the user already asked for stablecoins or
   altcoins, skip the yes/no and go straight to the walkthrough. Otherwise ask
   whether payers should also be able to pay with USDT, USDC, ETH or SOL. The
   walkthrough:

   > Go to https://lightning-swap.com, sign in for API keys, create a key, and
   > copy the whole URI (https://openreceive.org/set_up_swap_provider). Paste
   > it here and I will store it — or say "Bitcoin only" and I will continue
   > without it.

   Mention FixedFloat only if they already use it.
4. **When they paste it.** If it does not start with
   `lightning+swapconnect://`, ask them to copy it again. Otherwise add
   `LSC_URI_PRIMARY=<paste>` to the same `.env`, without echoing it. Swaps
   are now on, so build the refund route back (the swap non-negotiable below) as
   part of this integration. If they chose Bitcoin only, leave
   `LSC_URI_PRIMARY` unset and skip that route.
5. **Make the server load the file — yourself.** Nothing in PHP
   reads `.env` on its own. Add `vlucas/phpdotenv` and load the file in the
   front controller before `Service::fromEnvironment()`. When the app is started
   with Docker Compose, give the service `env_file: .env`. Restart PHP-FPM or
   the server after writing the file.

Do not invent placeholder URIs. Start the quickstart only once `NWC_URI` is
saved and `LSC_URI_PRIMARY` is saved or explicitly declined. The first boot
runs the receive-only preflight: if it reports spend methods such as
`pay_invoice`, remove `NWC_URI` from `.env` and ask for a receive-only code
again. Never set the spend-capable override to get past it.

Then check the PHP runtime: `php -m` must list `gmp`, `sodium`, `mbstring`,
`json`, `pdo` and one PDO driver. `ext-gmp` is REQUIRED — the NWC transport
signs every request with it — and `php:*-cli`/`-fpm` images do not ship it
(`docker-php-ext-install gmp`). PHP must be ≥ 8.2 and 64-bit.

### Upgrading an existing install

This is not the opening move of a new integration. When OpenReceive is ALREADY
installed here, `OpenReceive\Server\Doctor::report()` (a plain host runs it
from the quickstart's `bin/doctor` script) reports every credential as
set/unset (never the value), the host class and any placeholder hooks, the
mount, and the wallet preflight. Check the installed `openreceive/openreceive`
(`composer show openreceive/openreceive`) and the unpacked checkout's
`MANIFEST.json` against the release named at the top of this file. The two
must match: the browser build and the engine are one release. Upgrade first —
and if this app runs in containers, rebuild the images: `vendor/` is baked into
the image, so an in-place `composer update` is undone by the next
`compose up`.

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
- `onPaid` must be idempotent. Its database fulfillment commits once per `reference` — your order id, one
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

- Check Bitcoin → Switch payment method → Bitcoin: the grid must hide the
  Lightning invoice, then restore the same bolt11 without another mint.
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
- `swap.deposit_amount` is the only amount a payer is told to send. Never put
  a fiat valuation of it (`swap.fee.pay_in_fiat`) next to a stablecoin amount:
  "$50.03" under "50.05 USDC" reads as a typo, and the payer asks which one to
  send. The one fiat figure on a USDT/USDC deposit panel is the cart total
  (`payout_fiat`); express "you send" and the fee in the token. Use
  `createSwapFeeBreakdown(fee, swap)` — with the swap, not the fee alone — and
  it applies this for you; SOL and ETH keep a fiat breakdown.
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

- https://openreceive.org/guides/payment-safety-upgrade.md — coordinated upgrades and reviewed repair of existing attempts

---

## The quickstart, in full

Inlined verbatim so this file needs no network access — follow it once Step 0
passes. The page it comes from is https://openreceive.org/guides/quickstart-php.

## PHP quickstart (plain PHP)

This page is for plain PHP, with no framework: a front controller, a PDO handle
and three methods. Laravel has its own quickstart (`openreceive/laravel`, the
thin adapter over this engine).

Requires PHP ≥ 8.2 (64-bit) with `ext-gmp`, `ext-sodium`, `ext-mbstring`,
`ext-json`, `ext-pdo` and one PDO driver (`pdo_pgsql`, `pdo_sqlite` or
`pdo_mysql`). `ext-gmp` is **required**, not optional. The NWC transport signs
every wallet request with it.

### 1. Install

```sh
composer require openreceive/openreceive nyholm/psr7 nyholm/psr7-server
```

`openreceive/openreceive` is the whole engine. It includes the receive-only
wallet client, exact money, settlement, the `openreceive_payments` repository
over PDO, swaps, rates and a PSR-15 handler. It depends only on the PSR
interfaces, so bring the PSR-7/PSR-17 implementation your app already has.
`nyholm/psr7` + `nyholm/psr7-server` is the smallest pair, and this page uses
it.

The **checkout UI is not in the Composer package.** Packagist installs from git
and cannot run a JS build. So the browser side ships separately, as
`standalone-checkout-<version>.tar.gz` on every
[GitHub release](https://github.com/openreceive/openreceive/releases). It holds
one self-contained ES module, its stylesheet, a source map and a
`MANIFEST.json`. Unpack it somewhere your web server serves static files
(step 5). If your app has a JS bundler, you can `npm install @openreceive/elements`
instead. The tarball is the same build.

### 2. Migrate the payment tables

The engine owns two tables in **your** database and renders their DDL for each
SQL dialect. Run that DDL through whatever your app uses for schema changes:
Phinx, Doctrine Migrations, a plain SQL file, or a `bin/migrate` script.

```php
use OpenReceive\Storage\PaymentsSchema;

// $dialect is 'pgsql', 'mysql' or 'sqlite' (PDO::ATTR_DRIVER_NAME gives it to you).
foreach (PaymentsSchema::statements($dialect) as $sql) {
    $pdo->exec($sql);
}
// down(): PaymentsSchema::dropStatements()
```

If your script has no migration tool, `PaymentsSchema::migrate(new PdoConnection($pdo))`
does the same in one call. It creates two tables. Leave both to the library:

- `openreceive_payments`: one row per payment attempt.
- `openreceive_meta`: the reconcile gate and the schema version.

Details: [Payment storage](https://openreceive.org/guides/storage.md).

### 3. Add wallet credentials

Create a server-only `.env`, or export the variables from your process manager.
The engine reads `getenv()` and `$_ENV`.

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
receive-only code instead ([Security](https://openreceive.org/guides/security.md)).

Nothing in PHP loads a `.env` file on its own. Something has to put the values
in the process environment first: `vlucas/phpdotenv`, your web server's
`SetEnv`/`fastcgi_param`, or the container runtime
([Environment variables](https://openreceive.org/guides/environment-variables.md)).

### 4. Wire OpenReceive

Three methods on one object are the entire bridge between the engine and your
data. The engine never sees an order, a user or a price except through them.
`Engine` combines the wallet, the repository over your PDO, and that object
into a PSR-15 handler. Your front controller sends requests under one path
prefix to that handler:

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
the receive-only preflight. A missing, invalid or spend-capable code throws
before any route is served. PHP starts every request from nothing, so that
check runs on every request that reaches the engine.

The settlement gate the engine relies on lives in `openreceive_meta`, not in
memory. That is why a fleet of PHP-FPM workers shares one wallet-scan budget,
with no worker process of its own. Later OpenReceive requests also settle
pending invoices, so a payer who closes the tab is still covered. `authorize`
runs on every request.
→ [Engine](https://openreceive.org/guides/api-reference.md#openreceiveserverengine) ·
[Host](https://openreceive.org/guides/api-reference.md#openreceivehost) ·
[the authorize context](https://openreceive.org/guides/api-reference.md#the-authorize-context-php)

**Cross-site requests.** Plain PHP has no CSRF layer, just like Express, and the
engine does not need one. Every mounted route refuses a request whose
`Sec-Fetch-Site` header says `cross-site`. So a form or script on another
origin cannot create invoices using a payer's cookie. That makes
`<meta name="csrf-token">` optional. If you set it, the checkout sends the value
back as `X-CSRF-Token` (or the header named by `csrf-header`) for your own layer
to check.

The engine's check does NOT cover two cases:

- A browser too old to send `Sec-Fetch-Site`. The header is absent, and an
  absent header passes.
- Anything that is not a browser at all. A script holding a stolen cookie is a
  session problem, not a forgery problem.

`authorize` is still the boundary that decides whether *this caller* may act on
*this order* ([Security](https://openreceive.org/guides/security.md)).

For public web shops, turn on the per-IP invoice cap with `rateLimiting: true`
on `Engine`. Leave it off (the default) when many payers share one IP. Behind a
proxy, pass `clientIp: fn ($request) => …` so the cap counts the payer, not the
proxy. → [Rate limiting](https://openreceive.org/guides/rate-limiting.md)

Your app also needs an ordinary order-creation route. It validates the cart,
prices with exact decimal math, and returns the order id. The page then passes
that id as the `reference`. OpenReceive never prices from payer input.

The `reference` is a string you choose, and it is the fulfillment identity. Use
your order id:

- one per thing you fulfill,
- created before checkout,
- kept across retries,
- never reused.

`onPaid` commits fulfillment once per reference, and a new checkout under a
reference that already settled is refused with 409. A fresh id per page load
would let one order be paid twice.

Naming: PHP APIs use camelCase methods and snake_case array keys
(`amount_msats`, `payment_hash`). The keys match the wire format. The mounted
HTTP routes and the browser snapshots are snake_case throughout.

### 5. Render checkout

Serve the compiled `styles.css` without Tailwind processing. Either import it
from JavaScript (with a CSS-capable bundler) or use a plain
`<link rel="stylesheet">`. Do not `@import` it into your Tailwind entry. Its
rules have zero specificity, so your own styles can override checkout styles.
Scoping does not prevent that.

Unpack the release's `standalone-checkout-<version>.tar.gz` into a directory
your web server serves. This page uses `public/openreceive/`. Then add two tags
and the element:

```html
<link rel="stylesheet" href="/openreceive/openreceive-checkout.css" />
<script type="module" src="/openreceive/openreceive-checkout.js"></script>

<openreceive-checkout
  reference="<?= htmlspecialchars($order->id) ?>"
  prefix="/openreceive"
></openreceive-checkout>
```

The module registers `<openreceive-checkout>` as it loads. The element creates
the checkout for `reference`, then renders, polls and settles itself. The
stylesheet is scoped to what OpenReceive renders. The checkout follows the
payer's theme. On a page that always uses one theme, lock it with
`theme="dark"`. React, Vue, Svelte, and Angular apps use the matching wrapper
package instead, with the same attributes
([Frontend checkout](https://openreceive.org/guides/frontend-checkout.md)). A custom UI builds on
`@openreceive/browser/headless` ([Headless checkout](https://openreceive.org/guides/headless-checkout.md)).

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can load tutorial screenshots only when a tutorial is first opened.
Single-file builds, including the standalone checkout, include them upfront. If
your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](https://openreceive.org/guides/provider-registry.md#assets)).

`MANIFEST.json` in the tarball carries the version and a SHA-256 per file. You
can use it to check a copied tree against the release it came from. Keep the
tarball version in step with the Composer package.

Buy a Button
(`examples/buttons/server/php-plain`)
is a runnable illustration of this boundary. It is not a template to copy
models from. It has products, visitors, and orders, and the three hooks are the
only bridge. Map that shape onto the models in THIS app.

### 6. Verify

```php
foreach (\OpenReceive\Server\Doctor::report(
    \OpenReceive\Server\Service::processEnvironment(),
    $host,
    static fn () => \OpenReceive\Server\Service::fromEnvironment(),
    '/openreceive',
) as $line) echo $line, PHP_EOL;
```

`Doctor::report()` prints:

- every credential as set or unset, never its value;
- the host class, and which of the three methods are still the scaffolded
  placeholders (`Hosts\AllowAllAuthorize`, `Hosts\LoggingOnPaid`). The engine
  also warns at boot while either is in use;
- where the handler is mounted;
- the receive-only wallet preflight.

`$engine->doctor()` is the same report for an engine you already built. Put it
behind a `bin/doctor` script. The demo's is twelve lines.
→ [Doctor](https://openreceive.org/guides/api-reference.md#openreceiveserverdoctor)

Then open the checkout in a browser. Confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, check the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

### Reconciliation

Settlement runs on the request path. Every payment route first runs one bounded
reconcile pass through the durable `openreceive_meta` gate. The gate allows at
most one real wallet scan every 2 seconds, shared by every PHP process. You do
not need a cron job. Tune or disable it with `Engine`'s
`opportunisticReconcile` (`false`, or `['min_interval_seconds' => …]`).

Optionally, run one worker so settlement does not wait for the next page load:

```php
$engine->notificationsWorker()->run();   // blocks: an NWC-02 listener plus a periodic pass
```

Run it as its own long-lived process (`php bin/notifications`). To run a pass
yourself, use the one-shot `$engine->reconcile()`.
→ [Engine notificationsWorker](https://openreceive.org/guides/api-reference.md#engine-notificationsworker)

### Swap secrets

Setting `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP`) auto-builds the matching swap
providers. Nothing in your code changes. One `openreceive_payments` row holds
at most one provider order, in its server-only `swap_data`. The repository
never selects it into public arrays. Do not log it or return it from your own
API.

**Setting either connection string commits you to refunds.** A deposit that
arrives short or late is claimed on a second visit. That needs a per-order URL
your app serves, and the attempt's `payment_hash` kept.
[Swap refunds](https://openreceive.org/guides/swap-refunds.md) covers all of it. Read it before you set
`LSC_URI_PRIMARY`.
