# PHP quickstart (plain PHP)

This page is for plain PHP, with no framework: a front controller, a PDO handle
and three methods. Laravel has its own quickstart (`openreceive/laravel`, the
thin adapter over this engine).

Requires PHP ≥ 8.2 (64-bit) with `ext-gmp`, `ext-sodium`, `ext-mbstring`,
`ext-json`, `ext-pdo` and one PDO driver (`pdo_pgsql`, `pdo_sqlite` or
`pdo_mysql`). `ext-gmp` is **required**, not optional. The NWC transport signs
every wallet request with it.

## 1. Install

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

## 2. Migrate the payment tables

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

Details: [Payment storage](storage.md).

## 3. Add wallet credentials

Create a server-only `.env`, or export the variables from your process manager.
The engine reads `getenv()` and `$_ENV`.

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

Nothing in PHP loads a `.env` file on its own. Something has to put the values
in the process environment first: `vlucas/phpdotenv`, your web server's
`SetEnv`/`fastcgi_param`, or the container runtime
([Environment variables](environment-variables.md)).

## 4. Wire OpenReceive

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
→ [Engine](api-reference.md#openreceiveserverengine) ·
[Host](api-reference.md#openreceivehost) ·
[the authorize context](api-reference.md#the-authorize-context-php)

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
*this order* ([Security](security.md)).

For public web shops, turn on the per-IP invoice cap with `rateLimiting: true`
on `Engine`. Leave it off (the default) when many payers share one IP. Behind a
proxy, pass `clientIp: fn ($request) => …` so the cap counts the payer, not the
proxy. → [Rate limiting](rate-limiting.md)

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

## 5. Render checkout

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
([Frontend checkout](frontend-checkout.md)). A custom UI builds on
`@openreceive/browser/headless` ([Headless checkout](headless-checkout.md)).

Everything the checkout draws ships inside the JavaScript: the payment-method
icons, the wallet logos and the pay tutorials. There is no image file to copy
or serve and no asset option to set. Deploy your normal JavaScript and CSS
build output, including any generated JavaScript chunks. Bundlers with code
splitting can load tutorial screenshots only when a tutorial is first opened.
Single-file builds, including the standalone checkout, include them upfront. If
your Content-Security-Policy has a strict `img-src`, allow `data:`
([Provider registry](provider-registry.md#assets)).

`MANIFEST.json` in the tarball carries the version and a SHA-256 per file. You
can use it to check a copied tree against the release it came from. Keep the
tarball version in step with the Composer package.

Buy a Button
([`examples/buttons/server/php-plain`](../../examples/buttons/server/php-plain))
is a runnable illustration of this boundary. It is not a template to copy
models from. It has products, visitors, and orders, and the three hooks are the
only bridge. Map that shape onto the models in THIS app.

## 6. Verify

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
→ [Doctor](api-reference.md#openreceiveserverdoctor)

Then open the checkout in a browser. Confirm the payment-method icons and
wallet logos render, and open a wallet's pay tutorial to check its screenshots.
If an image is missing, check the console for CSP violations and the Network
panel for failed JavaScript chunks. Allow `data:` in `img-src` and deploy the
complete build output. Do not add image routes, copy package source images, or
use registry `icon_path` / tutorial `path` keys as browser URLs.

## Reconciliation

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
→ [Engine notificationsWorker](api-reference.md#engine-notificationsworker)

## Swap secrets

Setting `LSC_URI_PRIMARY` (and `LSC_URI_BACKUP`) auto-builds the matching swap
providers. Nothing in your code changes. One `openreceive_payments` row holds
at most one provider order, in its server-only `swap_data`. The repository
never selects it into public arrays. Do not log it or return it from your own
API.

**Setting either connection string commits you to refunds.** A deposit that
arrives short or late is claimed on a second visit. That needs a per-order URL
your app serves, and the attempt's `payment_hash` kept.
[Swap refunds](swap-refunds.md) covers all of it. Read it before you set
`LSC_URI_PRIMARY`.

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
