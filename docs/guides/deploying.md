# Deploying OpenReceive

Every web instance needs the same receive-only NWC configuration and access
to your database. NWC (Nostr Wallet Connect) is how the server talks to your
wallet. Attempt rows, the settlement claim, and the scan gate all live in the
database. There is no separate OpenReceive service to deploy.

On a serverless host (Vercel, Netlify, AWS Lambda, Google Cloud Run), also
read [Bitcoin checkout on serverless hosts](serverless.md): pooled database
URLs, function timeouts, and why no cron job is needed.

## Requirements

| Stack | Floor |
| --- | --- |
| Node (Express, Fastify, Next.js, NestJS) | Node ≥ 22; the App Router on Next.js ≥ 15; NestJS ≥ 10 on its Express platform; PostgreSQL, SQLite, or MySQL ≥ 8.0.16 / MariaDB ≥ 10.2.7 (InnoDB) |
| Rails | Ruby ≥ 3.2, Rails ≥ 8.0; PostgreSQL, SQLite or MySQL (`mysql2`/`trilogy`) |
| FastAPI | Python ≥ 3.10, FastAPI ≥ 0.115 (Starlette ≥ 0.40), a sync SQLAlchemy 2 `Engine`; PostgreSQL, SQLite or MySQL |
| Django | Python ≥ 3.10, Django ≥ 5.2; PostgreSQL, SQLite (`transaction_mode: IMMEDIATE`) or MySQL ≥ 8.0.16 / MariaDB ≥ 10.2.7 |
| Flask | Python ≥ 3.10, Flask ≥ 3, a SQLAlchemy 2 `Engine`; PostgreSQL, SQLite or MySQL |
| PHP (plain) | PHP ≥ 8.2, 64-bit, with `ext-gmp` (required by the NWC transport), `ext-sodium`, `ext-mbstring`, `ext-pdo` + `pdo_pgsql`/`pdo_sqlite`/`pdo_mysql`. PHP-FPM or Apache in front of one front controller. `php -S` is a development server only |
| Laravel | PHP ≥ 8.2, 64-bit, Laravel ≥ 11, with `ext-gmp` (required by the NWC transport), `ext-sodium`, `ext-mbstring`, `ext-pdo` + `pdo_pgsql`/`pdo_mysql`/`pdo_sqlite`. PostgreSQL, MySQL/MariaDB or SQLite. PHP-FPM or Apache. `php artisan serve` is a development server only |
| WordPress plugin (WooCommerce, Easy Digital Downloads) | WordPress ≥ 6.6 with WooCommerce ≥ 9 or Easy Digital Downloads ≥ 3; PHP ≥ 8.2, 64-bit, with `ext-gmp` and `ext-sodium`; WordPress's MySQL/MariaDB database |
| Paymenter extension | Paymenter ≥ 1.5; PHP ≥ 8.3, 64-bit, with `ext-gmp` and `ext-sodium`; Paymenter's cron job running |
| FOSSBilling module | FOSSBilling ≥ 0.8; PHP ≥ 8.3, 64-bit, with `ext-gmp` and `ext-sodium`; FOSSBilling's cron job running |
| PrestaShop module | PrestaShop 9; PHP ≥ 8.2, 64-bit, with `ext-gmp` and `ext-sodium`; a cron line for the module's reconcile pass |
| Odoo module | Odoo 19 or 20, self-hosted or on Odoo.sh, with the `openreceive` Python package installed at the module's version |
| Medusa plugin | Medusa 2 on Node ≥ 22.12, with PostgreSQL; Medusa's scheduled jobs running |
| Vendure plugin | Vendure ≥ 3.3 on Node ≥ 22.12, with PostgreSQL, MySQL or MariaDB; Vendure's worker running |
| BTCPay Server plugin | BTCPay Server ≥ 2.4.4 |

Every stack needs the same two things at runtime:

- A receive-only NWC code in the server environment.
- A database your app already owns. The library adds two tables to it.

It needs nothing else: no Redis, no queue, no OpenReceive service.

## Multi-instance semantics

You can run as many web instances as you like. The database makes
concurrent creates for the same order run one at a time. Settlement is
written once and never changed. After a restart, or when instances overlap,
they repeat limited passes that are safe to run twice. A payment is never
fulfilled twice.

Each process caches rates and provider weights in memory. These caches only
save time. Restarting may cause extra calls, but never loses anything stored
in the database.

## The durable scan gate

By default, settlement happens during normal requests. The mounted
OpenReceive routes settle pending invoices as payers use them. The optional
notifications worker below is the only separate process.

When attempts are pending, every mounted OpenReceive payment route runs one
reconcile pass. `GET /rates` is the exception. A reconcile pass checks the
wallet for payments to pending invoices. All open tabs share that pass. So if
one payer closes the tab, another payer's later request can settle the first
invoice.

You do not need a cron job. An unpaid attempt is only closed after a
successful wallet scan at or after its expiry. The local clock alone never
closes it.

## Worker topology

No background process is required. You can optionally add one:

- **Node**: run one `startNotificationWorker({ service, host })` process in
  total, not one per instance. It listens for wallet `payment_received`
  notifications and runs a periodic backup pass.
- **Rails**: `bin/rails openreceive:notifications`. The one-shot tools
  `OpenReceive.reconcile!`, `OpenReceive::ReconcileJob`, and
  `bin/rails openreceive:reconcile` are still available. Nothing needs
  scheduling.
- **Laravel**: `php artisan openreceive:notifications`, one process in total.
  Compose runs it as a second service from the same image.
  `php artisan openreceive:reconcile` is the one-shot pass.
- **Plain PHP**: `php bin/notifications`, one long-lived process in total,
  built on `$engine->notificationsWorker()->run()`. `$engine->reconcile()` is
  the one-shot pass.
- **Python**: `openreceive notifications --app main:app`, one process in
  total. `--app` can point at the FastAPI app, the router, or an
  `OpenReceiveApp`. `openreceive
  reconcile --app …` is the one-shot pass. In Django, the same two commands
  are `manage.py openreceive_notifications` / `openreceive_reconcile`.

The workers use the same gate and the same write-once settlement path as
the pass that runs during requests.

## When your application boots

If the NWC connection is missing or can spend funds, OpenReceive refuses to
take payments.

On Node, the adapters check the wallet on the first request. Await that check
in a deploy health check. Express and Next expose a `ready` promise. On
Fastify, use `await fastify.ready()`.

The Rails engine checks the wallet when the app boots in production. So a bad
`NWC_URI` stops the deploy instead of showing customers a 500. Asset
precompilation skips that check, because secrets are not mounted yet. For any
other boot without secrets, set `config.eager_preflight = false`. That turns
off only the boot check. The wallet is still checked on the first request.

On FastAPI, the check runs in the lifespan.
`FastAPI(lifespan=openreceive_lifespan(host,
engine=engine))` runs the receive-only preflight when uvicorn starts. If it
fails, it stops the process, so the deploy fails instead of the first payer.
`lazy=True` delays the check to the first request, which helps in tests and
build steps without secrets. Until the wallet passes, requests get
`503 WALLET_UNAVAILABLE`.

On Django, the wallet client is built lazily on the first request. It is
NEVER built in `AppConfig.ready()`. That method runs for `migrate`,
`collectstatic` and shells, and a relay probe there would break steps that
run without secrets. To get the same early check that Rails does in
production, put the preflight in your deploy pipeline:

- `OPENRECEIVE_PREFLIGHT=1 manage.py check --deploy` runs it as the system
  check `openreceive.E002`. It fails the deploy if the code is missing, dead
  or can spend funds.
- `manage.py openreceive_doctor` runs the same probe for a person to read.

Until the first request passes, the mounted routes answer
`503 WALLET_UNAVAILABLE`.

### Where boot failures go

If boot fails, later requests answer `503 WALLET_UNAVAILABLE`, and
`await ready` rejects. On the Node adapters, pass `onBootFailure` to send that
one line to your logger.

## Node in Docker

OpenReceive does not generate a Dockerfile for you. These are the rules that
matter:

- **Never bake wallet URIs into the image.** No `COPY .env`. No `ARG` or
  `ENV` carrying `NWC_URI` / `LSC_URI_*`. Put `.env` in `.dockerignore`.
  Inject secrets at runtime, with compose `env_file` or your orchestrator's
  secrets.
- **Use a multi-stage build.** A build stage installs dev dependencies and
  compiles. The runtime stage copies only production `node_modules` and the
  build output.
- **Prisma needs a `DATABASE_URL` to run `prisma generate` at build time.**
  Give it a dummy value in the build stage. The real one arrives at runtime.
- **Migrate on boot, not at build.** The database is not reachable while the
  image builds. Run `npx prisma migrate deploy` (or your ORM's equivalent) in
  the entrypoint before starting the server.
- **Keep SQLite on a volume.** The next deploy erases a database file inside
  the container filesystem.

Prisma's CLI loads `.env` automatically for **every** command. That includes
commands you run on the host outside Docker. So a container-path
`DATABASE_URL` (`file:/data/shop.db`) in `.env` silently breaks
`prisma migrate deploy` on the host. Keep two URLs. Put the host path in the
dockerignored `.env`, and inject the container path at runtime. Never use one
in place of the other.

## Rails in Docker

`openreceive-rails → nwc-ruby → rbsecp256k1` compiles libsecp256k1 from
source, and Bundler compiles the newer `openssl` gem that `nwc-ruby`'s
connection libraries need. So slim images need the autotools and the OpenSSL
headers in the build stage. Without them, `bundle install` fails with
`autoreconf: not found` or at `checking for openssl/ssl.h... no`:

```dockerfile
RUN apt-get update && apt-get install -y autoconf automake libtool build-essential pkg-config libssl-dev
```

## Laravel in production

Under PHP-FPM or Apache, PHP boots your app fresh on every request. The
engine's `Service` runs a receive-only wallet preflight when it is
constructed, so that check would run on every request. To avoid this, the
package stores the wallet's info event in your app's default cache store for
`config('openreceive.wallet_info_cache_seconds')` (600 by default). So a
checkout request costs one relay round trip. The same store keeps the BTC
price and the swap provider's currencies and rates between requests.

Rails runs an early preflight in production. Here, the same check runs on each
web boot that misses the cache. It never runs in `php artisan config:cache`,
`migrate`, or the other build commands that run without secrets.

- `php artisan config:cache` captures `NWC_URI` / `LSC_URI_*` when it runs.
  Rebuild the cache after you replace a code.
- Migrate in the entrypoint, not at build (`php artisan migrate --force`).
- The same secret rules as Node apply to the image: never `COPY .env`, never
  an `ENV NWC_URI`.
- The notifications worker is `php artisan openreceive:notifications`, one
  process in total. Use the same image as the web process with a different
  command. `ext-pcntl` lets it stop cleanly on SIGTERM.

## Plain PHP in production

PHP boots the engine again on every request. Under a web server,
`Service::fromEnvironment()` keeps the wallet's info event and the market data
in a directory under the system temp dir that only the PHP user can open, so
a checkout route does not ask for them again. Each server keeps its own copy.
Nothing in it needs a backup: deleting it costs one slower request. When the
temp dir is not writable (`open_basedir`, a read-only file system) the engine
runs without the cache and each checkout route takes seconds longer. Pass your
own cache as `sharedCache:` then
([Service](api-reference.md#openreceiveserverservice)).

## Python (FastAPI) in production

The engine is synchronous on purpose. One wallet RPC is one blocking call.
An async engine would be a second settlement implementation to maintain. So
the router's endpoint runs in Starlette's threadpool. That is the same pool
`def` endpoints use, with about 40 threads by default.

A slow relay holds a thread for at most the service's wallet deadline (10 s).
That deadline is the limit, and OpenReceive has no setting for the pool. If a
busy shop needs more room, do one of these:

- Raise the pool at startup with anyio. Inside the lifespan, set
  `anyio.to_thread.current_default_thread_limiter().total_tokens = 80`.
- Run more uvicorn workers.

Behind a reverse proxy, run uvicorn with `--proxy-headers`. Then
`request.client` is the payer, not the proxy. `rate_limiting` counts by
`request.client`.

The same secret rules as Node apply to the image: never `COPY .env`, never an
`ENV NWC_URI`. Inject secrets at runtime. Install the engine with `uv` or
`pip` on Python ≥ 3.10 (`pip install "openreceive[fastapi]"`). Migrate with
the Alembic revision that `openreceive scaffold payments --alembic` generates.
Run it in the entrypoint, not at build.

## Python (Django) in production

`manage.py migrate` applies the engine's shipped migration along with your
own. Run it in the entrypoint, not at build.

- The packaged static checkout
  (`{% static "openreceive/openreceive-checkout.js" %}`) ships through
  `collectstatic` like any other static file.
- The notifications worker is `manage.py openreceive_notifications`, one
  process in total. Use the same image as the web process with a different
  command.
- The same secret rules as Node apply: never `COPY .env`, never an
  `ENV NWC_URI`. Inject secrets at runtime.

## Operational monitoring

`attention` rows need a person to look at them. Payers never see this
status. To them, the checkout still looks pending or expired. So alert on
these rows internally:

```sql
SELECT reference, payment_hash, status_reason, expires_at
FROM openreceive_payments
WHERE status = 'attention';
```

Check each one in the wallet. If it actually settled, the next reconcile
pass records it. If it is stuck, resolve it in the wallet.

See [Payment storage](storage.md) and [Rate limiting](rate-limiting.md).

## WordPress + WooCommerce or Easy Digital Downloads

Install the plugin from the WordPress.org directory
(`wp plugin install openreceive --activate`), or upload the
`openreceive-wordpress-<version>.zip` attached to each GitHub release. The
plugin includes its PHP dependencies and browser assets. Configure the wallet
in the store's payment settings or in server-only constants. Attempts
are stored in the existing WordPress MySQL/MariaDB database. On quiet shops,
set up a system cron to run Action Scheduler. You can also run
`wp openreceive notifications` as an optional separate process. See the [WooCommerce quickstart](quickstart-woocommerce.md).
