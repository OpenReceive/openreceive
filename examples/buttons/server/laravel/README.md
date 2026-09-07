# Buy a Button — Laravel + Postgres

Laravel 12 over the PHP engine, Postgres, Vite, PHPUnit, uuid primary keys. The
shop UI comes from [`../../shared`](../../shared); this directory is the host:
its routes, its Eloquent models, its migrations, its build. The OpenReceive
binding is [`openreceive/laravel`](../../../../packages/php/laravel) over
[`openreceive/openreceive`](../../../../packages/php/openreceive), both resolved
from this monorepo through Composer path repositories.

See [`../../README.md`](../../README.md) for what the demo is and why the
boundary falls where it does.

## Running it

From the repository root, in Docker:

```sh
cp -n .env.example .env      # set a receive-only NWC_URI
npm run demo laravel         # http://localhost:3005
```

For an edit-reload loop, from this directory:

```sh
composer install
npm install                  # from the repository root, once
npm run dev                  # Vite on :3005 fronting `php artisan serve`
```

Laravel's own Vite is the front door in development: `vite/laravel-front-door.ts`
spawns `php artisan serve` on an internal port, runs `migrate` + `db:seed`
first, forwards the paths the app owns (`/`, `/checkout/:id`, `/shop`,
`/openreceive`, `/images`, `/__testkit`) to it, and writes the `public/hot`
file the Blade `@vite` directive reads — one port, the same host code
production runs. Locally the shop is a SQLite file under
`examples/buttons/.data` (WAL, busy timeout); compose runs Postgres. If the
dev server was killed hard, a stale `public/hot` makes `php artisan serve` on
its own point at a Vite that is gone: `rm public/hot`.

**The browser never receives your NWC code.** It is read from the
repository-root `.env` by server code only, and no part of it reaches a bundle,
a log or an asset.

## Running it with no wallet

```sh
DEMO_WALLET=testkit npm run dev     # no NWC_URI, no LSC keys, no network
```

Testkit mode replaces THREE THINGS — the wallet, the swap provider and the
price feed — with the engine's in-memory fakes, and nothing else: the engine,
the three hooks, the migrations, the controllers and the SPA are the production
paths. This is a fake wallet, not a fake application.

The fakes are the engine's own `OpenReceive\Testing\FakeWallet` and
`FakeSwapProvider`, a PORT of `packages/js/testkit` down to the fixtures:
payment hashes are the mint counter in 64 hex characters, the Tron deposit
address is `T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb`, provider orders are
`testkit-swap-N`, and BTC is a static $50,000 so a $1.00 button is 2,000 sats.
That is what lets one Playwright suite drive this stack and every other with
the same assertions (`OPENRECEIVE_E2E_STACK=laravel npm run test:e2e:smoke`).

THE ONE THING PHP HAS TO DO THAT THE OTHER STACKS DO NOT: keep the fakes alive
between requests. A Node process holds its fake wallet in memory for the life
of the server; a PHP request starts from nothing, so an invoice minted by
`POST /openreceive/checkouts` would be unknown to the `POST /__testkit/settle`
that follows. [`app/Testkit/Testkit.php`](app/Testkit/Testkit.php) snapshots
the fakes' state to a file beside the SQLite database after every request and
restores it before the next, under a lock held for the request.

The control surface is the same one every stack mounts:

- `POST /__testkit/settle { payment_hash }`
- `POST /__testkit/expire { payment_hash }`
- `POST /__testkit/swap-step { provider_order_id | pay_in_asset, state }`
- `GET /__testkit/state`

**The route is declared unconditionally and refuses unconditionally.**
`Testkit::enabled()` reads `DEMO_WALLET` and is the only thing standing
between a production boot and a surface that can settle invoices, so every
action is a JSON 404 without it — `tests/Feature/TestkitOffTest.php` asserts
exactly that, in an environment that does not set the variable. No compose file
sets it either, which `npm run check:demo-containers` enforces.

## Persistence is host-owned

This app owns its database — Postgres in compose, SQLite locally. OpenReceive
has no database configuration of its own: the engine's two tables
(`openreceive_payments`, `openreceive_meta`) live in this same host database,
created by the migration `php artisan openreceive:install` published.

Four tables are ours:

| table | what it is |
| --- | --- |
| `shop_products` | the price authority. Read fresh on every order creation — never memoized. |
| `shop_users` | a visitor. Two uuids, two timestamps, no credentials. |
| `shop_orders` | one cart checkout. `id` IS the OpenReceive reference. |
| `shop_order_items` | one sku on one order, with name and price SNAPSHOTTED beside a nullable product FK. |

The snapshots are why deactivating or deleting a product cannot break a receipt,
a download or a feed row somebody already paid for.

## Where to read

| file | what it decides |
| --- | --- |
| `app/OpenReceive/Host.php` | the three hooks. The whole bridge. |
| `config/openreceive.php` | the host class by NAME (config:cache), rate limiting on, the `web` middleware group. |
| `app/Models/ShopOrder.php` | `claimPaid()` — the guarded UPDATE the money rests on. |
| `app/Support/Visitor.php` | the encrypted cookie, and why `authorize` reads it without minting anyone. |
| `app/Http/Controllers/ShopController.php` | `normalizedLines()` (the trust boundary) and the two payload builders that must never converge. |
| `app/Providers/AppServiceProvider.php` | testkit mode: the three container seams bound to the fakes. |
| `vite/laravel-front-door.ts` | Vite as the dev front door over `php artisan serve`. |

## The two processes

`compose.yml` runs the same image twice:

| service | command | what it is |
| --- | --- | --- |
| `buttons-laravel` | the image default (Apache + PHP) | the web process |
| `notifications` | `php artisan openreceive:notifications` | the long-running worker |

The worker listens for NWC-02 `payment_received` from the wallet and runs a
periodic reconcile pass in the same process — the safety net for notifications
missed while it was down. Locally `npm run dev` runs only the web process;
settlement still lands, because the web process settles on the payer's own
`payments/check` call through the durable `openreceive_meta` gate.

There is no realtime push in this stack: the shared client polls the checkout
and re-reads its own order row, which is the production path the other
poll-only stacks use too.

## Tests

```sh
vendor/bin/phpunit            # the feature suite, on SQLite in memory
bin/ci                        # composer install, migrate + seed and the suite against Postgres, the drift/boundary checks, composer audit
npm run typecheck -w @openreceive/example-buttons-laravel
```

`bin/ci` also runs:

- `script/check-migration-drift.php` — the committed openreceive migration is a
  snapshot of the package's install stub; this re-renders and diffs it.
- `../rails/script/check-catalog-artwork.mjs` — every row in
  `shared/shop-catalog.json` names a file that exists in `examples/buttons/images`.
- `script/check-shared-boundary.php` — this stack may import
  `shared/shop-types.ts`, `shared/*.ts` and `shared/client/**`, and never
  `shared/server-node/**` or `shared/client-vanilla/**`.

## Build failure modes, ranked by how long they cost

1. `DB::transaction()` inside `onPaid`. The engine already holds the
   transaction on that PDO; a nested `BEGIN` throws and the settlement rolls
   back — the feature tests use `DatabaseMigrations` rather than
   `RefreshDatabase` for the same reason.
2. A JSON test request without `withCredentials()`. Laravel's test client
   sends no cookies on `postJson` otherwise, and the visitor is a stranger.
3. A closure in `config/openreceive.php`. Works until the first
   `php artisan config:cache`.
4. `ext-gmp` missing. The NWC transport needs it; `openreceive:doctor`'s wallet
   line fails before any request does.
5. A stale `public/hot` after the dev server died. Blade points at a Vite that
   is not there; delete the file.
