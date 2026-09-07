# openreceive/laravel

OpenReceive for Laravel: a receive-only Lightning (NWC) checkout mounted inside
your own application, over your own database. This package is the thin
Laravel binding of the [`openreceive/openreceive`](../openreceive) engine — the
service provider, the routes, `php artisan openreceive:install` and the
`openreceive:doctor` / `openreceive:reconcile` / `openreceive:notifications`
commands. Requires PHP ≥ 8.2 with `ext-gmp`, `sodium`, `mbstring` and a `pdo_*`
driver, and Laravel 11 or 12.

```sh
composer require openreceive/laravel
php artisan openreceive:install
php artisan migrate
```

`openreceive:install` writes three files:

- `config/openreceive.php` — settings. Hooks are named by CLASS, not closures,
  so `php artisan config:cache` works;
- `app/OpenReceive/Host.php` — the three hooks (`authorize`, `amountFor`,
  `onPaid`), with the two generated placeholders wired and the fulfillment
  note as comments. The engine warns at every boot until both placeholders are
  replaced;
- `database/migrations/*_create_openreceive_tables.php` — one migration for
  `openreceive_payments` and `openreceive_meta`, in your database, run by
  `php artisan migrate` like any other. Its DDL comes from the engine's
  `PaymentsSchema::statements($driver)`; PostgreSQL, MySQL/MariaDB and SQLite.

Set `NWC_URI` in `.env`, fill in `Host.php` against your order model, and
render `<openreceive-checkout reference="{{ $order->id }}">` with
`@openreceive/elements` through Vite. The whole walk-through is the
[Laravel quickstart](../../../docs/guides/quickstart-laravel.md).

## What the provider does

- Binds `OpenReceive\Host` from `config('openreceive.host')`, the
  `SqlPaymentRepository` over `DB::connection(config('openreceive.connection'))`'s
  PDO, and `OpenReceive\Server\Service` from `NWC_URI` (with swap providers
  auto-built from `LSC_URI_PRIMARY` / `LSC_URI_BACKUP`), all lazily.
- Mounts one catch-all route under `config('openreceive.route_prefix')`
  (`/openreceive`) and `config('openreceive.middleware')` (`['web']`): the
  engine's PSR-15 handler decides 404/405 inside the prefix, reads the body
  under its own cap and content-type gate, and refuses `Sec-Fetch-Site:
  cross-site`. The `web` group adds Laravel's session and CSRF check —
  `VerifyCsrfToken` reads `X-CSRF-TOKEN`, which the checkout client sends from
  `<meta name="csrf-token">` with no attribute needed.
- Hands your `authorize` the **Illuminate request** (`$context->request`), with
  its session and cookies, the way Rails passes `ActionDispatch::Request`. The
  client IP for the optional per-IP rate limit is `$request->ip()`, so
  `TrustProxies` decides who the payer is.
- Warns at boot while a placeholder trait is still in `Host.php`; in
  production runs the receive-only wallet preflight eagerly when a web process
  boots (a bad or spend-capable `NWC_URI` stops the deploy), skipping the
  known secretless build commands (`config:cache`, `migrate`, …).

Container seams a host or a test may bind before the engine is resolved:
`OpenReceive\Nwc\ReceiveNwcClient` (the wallet client, in place of `NWC_URI`),
`OpenReceive\Rates\PriceProvider`, and `openreceive.swap_providers` (a list; `[]`
disables swaps). The engine's `Testing\FakeWallet` and `Testing\FakeSwapProvider`
fit those seams, which is how the tests here and the Buy a Button demo's
`DEMO_WALLET=testkit` mode run with no wallet and no network.

## Commands

| Command | What it does |
| --- | --- |
| `php artisan openreceive:install [--force]` | Scaffold the config, the Host and the migration. |
| `php artisan openreceive:doctor [--no-wallet]` | Credentials as set/unset (never a value), the host and its placeholders, the route mount, the wallet preflight. |
| `php artisan openreceive:reconcile` | One reconciliation pass over pending attempts. |
| `php artisan openreceive:notifications` | The optional long-running worker: NWC-02 `payment_received` listener plus a periodic pass every `OPENRECEIVE_NOTIFICATIONS_RECONCILE_INTERVAL_SECONDS` (default 15), resubscribing with backoff. One per deployment. |

Settlement discovery needs no worker: every mounted OpenReceive payment route
first runs one reconcile pass through the durable `openreceive_meta` gate, so
pending attempts settle on any later request. `openreceive:notifications` only
makes it faster.

## Development

```sh
composer install       # resolves ../openreceive through the path repository
vendor/bin/phpunit     # Orchestra Testbench: routes, CSRF, authorize, migration, config:cache, doctor, preflight
vendor/bin/phpstan     # level 8
OPENRECEIVE_TEST_PGSQL_DSN='pgsql:host=127.0.0.1;port=5432;dbname=x' OPENRECEIVE_TEST_PGSQL_USER=… vendor/bin/phpunit --filter Migration
```

The `path` repository in `composer.json` is for this monorepo; Packagist
ignores it, and the published constraint on `openreceive/openreceive` is the
lockstep `~X.Y.Z` of the same release.
