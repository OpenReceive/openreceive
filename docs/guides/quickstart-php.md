# PHP quickstart (plain PHP)

Plain PHP, no framework. Requires PHP ≥ 8.2 (64-bit) with `ext-gmp`, `ext-sodium`,
`ext-mbstring`, `ext-json`, `ext-pdo` and one PDO driver (`pdo_pgsql`,
`pdo_sqlite` or `pdo_mysql`). `ext-gmp` is **required**, not optional: the NWC
transport signs every wallet request with it. Laravel has its own quickstart
(`openreceive/laravel`, the thin adapter over this engine); this page is the
one for a host with no framework at all — a front controller, a PDO handle and
three methods.

## 1. Install

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
self-contained ES module, its stylesheet, the provider assets and a
`MANIFEST.json`. Unpack it somewhere your web server serves as static files
(step 5). A host with a JS bundler can `npm install @openreceive/elements`
instead; the tarball is the same build.

## 2. Migrate the payment tables

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
[Payment storage](storage.md).

## 3. Add wallet credentials

Create a server-only `.env` (or export the variables from your process
manager — the engine reads `getenv()` and `$_ENV`):

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

Nothing in PHP loads a `.env` file on its own; `vlucas/phpdotenv`, your web
server's `SetEnv`/`fastcgi_param`, or the container runtime has to put the
values in the process environment first
([Environment variables](environment-variables.md)).

## 4. Wire OpenReceive

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
→ [Engine](api-reference.md#openreceiveserverengine) ·
[Host](api-reference.md#openreceivehost) ·
[the authorize context](api-reference.md#the-authorize-context-php)

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
whether *this caller* may act on *this order* ([Security](security.md)).

For public web shops, opt into the per-IP invoice cap with
`rateLimiting: true` on `Engine`; leave it off (the default) when many payers
share one IP. Behind a proxy pass `clientIp: fn ($request) => …` so the cap
counts the payer, not the proxy. → [Rate limiting](rate-limiting.md)

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

## 5. Render checkout

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
([Frontend checkout](frontend-checkout.md)); a custom UI builds on
`@openreceive/browser/headless` ([Headless checkout](headless-checkout.md)).

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set, under any bundler or with none. The
tutorials load as a lazy chunk on first open. If your Content-Security-Policy
has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

`MANIFEST.json` in the tarball carries the version and a SHA-256 per file, so a
copied tree can be checked against the release it came from; keep the tarball
version in step with the Composer package.

A runnable illustration of this boundary — not a template to copy models from —
is Buy a Button
([`examples/buttons/server/php-plain`](../../examples/buttons/server/php-plain)).
It has products, visitors, and orders, with the three hooks as the only bridge.
Map that shape onto the models in THIS app.

## 6. Verify

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
is twelve lines. → [Doctor](api-reference.md#openreceiveserverdoctor)

Then open the checkout in a browser and confirm the wallet logos and
payment-method icons render. Nothing is served from disk, so a missing image
means a Content-Security-Policy `img-src` that blocks `data:` — the browser
console names it.

## Reconciliation

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
→ [Engine notificationsWorker](api-reference.md#engine-notificationsworker)

## Swap secrets

Setting `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP`) auto-builds the matching
swap providers; nothing in your code changes. One `openreceive_payments` row
holds at most one provider order in its server-only `swap_data`; the
repository never selects it into public arrays — do not log it or return it
from your own API. **Setting either connection string commits you to
refunds**: a deposit that arrives short or late is claimed on a second visit,
which needs a per-order URL your app serves and the attempt's `payment_hash`
kept. [Swap refunds](swap-refunds.md) is the whole of it; read it before you
set `LSC_URI_PRIMARY`.

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
