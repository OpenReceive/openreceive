# Deploying OpenReceive

Every web instance needs the same receive-only NWC configuration and access
to your database. Attempt rows, the settlement claim, and the scan gate all
live there. There is no separate OpenReceive deployment service.

## Requirements

| Stack | Floor |
| --- | --- |
| Node (Express, Fastify, Next.js) | Node ≥ 22; the App Router on Next.js ≥ 15 |
| Rails | Ruby ≥ 3.2, Rails ≥ 8.0; PostgreSQL, SQLite or MySQL (`mysql2`/`trilogy`) |
| FastAPI | Python ≥ 3.10, FastAPI ≥ 0.115 (Starlette ≥ 0.40), a sync SQLAlchemy 2 `Engine`; PostgreSQL, SQLite or MySQL |
| Django | Python ≥ 3.10, Django ≥ 5.2; PostgreSQL, SQLite (`transaction_mode: IMMEDIATE`) or MySQL ≥ 8.0.16 / MariaDB ≥ 10.2.7 |
| PHP (plain) | PHP ≥ 8.2, 64-bit, with `ext-gmp` (required by the NWC transport), `ext-sodium`, `ext-mbstring`, `ext-pdo` + `pdo_pgsql`/`pdo_sqlite`/`pdo_mysql`; PHP-FPM or Apache in front of one front controller — `php -S` is a development server |
| Laravel | PHP ≥ 8.2, 64-bit, Laravel ≥ 11, with `ext-gmp` (required by the NWC transport), `ext-sodium`, `ext-mbstring`, `ext-pdo` + `pdo_pgsql`/`pdo_mysql`/`pdo_sqlite`; PostgreSQL, MySQL/MariaDB or SQLite; PHP-FPM or Apache, `php artisan serve` is a development server |
| BTCPay Server plugin | BTCPay Server ≥ 2.4.2 |

Every stack needs the same two things at runtime: a receive-only NWC code in
the server environment, and a database the application already owns — the
library adds two tables to it and asks for nothing else (no Redis, no queue,
no OpenReceive service).

## Multi-instance semantics

Scale web instances freely. Concurrent creates for the same order serialize
in the database. Settlement is write-once. Restarts and overlapping work
repeat bounded, idempotent passes — a payment is never fulfilled twice.

Process-local caches (rates, provider weights) are performance only.
Restarting may cause extra calls, never lost durable truth.

## The durable scan gate

Settlement runs on the request path by default: the mounted OpenReceive
routes settle pending invoices as payers use them, and the optional
notifications worker below is the only separate process. Every mounted OpenReceive
payment route (not `GET /rates`) runs one reconcile pass when attempts are
pending. Open tabs share that pass: when one payer closes the tab, another
payer's later request can settle the first invoice.

You do not need a cron job. Closing an unpaid attempt still waits for a
successful wallet scan at or after expiry — never the local clock alone.

## Worker topology

No background process is required. Optional additions:

- **Node** — one `startNotificationWorker({ service, host })` process total
  (not per instance). It listens for wallet `payment_received` notifications
  and runs a periodic safety-net pass.
- **Rails** — `bin/rails openreceive:notifications`. One-shot primitives
  (`OpenReceive.reconcile!`, `OpenReceive::ReconcileJob`,
  `bin/rails openreceive:reconcile`) remain available; nothing needs
  scheduling.
- **Laravel** — `php artisan openreceive:notifications`, one process total
  (compose runs it as a second service from the same image);
  `php artisan openreceive:reconcile` is the one-shot pass.
- **Python** — `openreceive notifications --app main:app` (the FastAPI app,
  the router, or an `OpenReceiveApp`), one process total; `openreceive
  reconcile --app …` is the one-shot pass. Django spells the same two as
  `manage.py openreceive_notifications` / `openreceive_reconcile`.

Both workers use the same gate and the same write-once settlement path as
the request-path pass.

## When your application boots

A missing or spend-capable NWC connection fails closed.

On Node the adapters check the wallet on the first request. Await that in a
deploy health check: Express and Next expose a `ready` promise; on Fastify
use `await fastify.ready()`.

The Rails engine checks the wallet when the app boots in production, so a
bad `NWC_URI` stops the deploy instead of becoming a customer-facing 500.
Asset precompilation skips that check (secrets are not mounted yet). For
any other secretless boot, `config.eager_preflight = false` turns off the
boot check only — the wallet is still checked on the first request.

On FastAPI the check is the lifespan: `FastAPI(lifespan=openreceive_lifespan(host,
engine=engine))` runs the receive-only preflight when uvicorn starts and stops
the process on failure — the deploy fails, not the first payer. `lazy=True`
defers it to the first request (tests, secretless build steps), which then
answers `503 WALLET_UNAVAILABLE` until the wallet passes.

On Django the wallet client is built lazily on the first request and NEVER in
`AppConfig.ready()` — that method runs for `migrate`, `collectstatic` and
shells, where a relay probe would break a secretless step. Rails' "eager in
production" is achieved by putting the preflight in the deploy pipeline
instead: `OPENRECEIVE_PREFLIGHT=1 manage.py check --deploy` runs it as the
system check `openreceive.E002` and fails the deploy on a missing, dead or
spend-capable code; `manage.py openreceive_doctor` is the same probe for a
person. Until the first request passes, the mounted routes answer
`503 WALLET_UNAVAILABLE`.

### Where boot failures go

If boot fails, later requests answer `503 WALLET_UNAVAILABLE`. `await ready`
rejects. Pass `onBootFailure` on the Node adapters to send that one line to
your logger.

## Node in Docker

There is no scaffolded Docker path; these are the rules that matter:

- **Never bake wallet URIs into the image.** No `COPY .env`, no `ARG` or
  `ENV` carrying `NWC_URI` / `LSC_URI_*`, and `.env` in `.dockerignore`.
  Inject secrets at runtime: compose `env_file`, orchestrator secrets.
- **Multi-stage build.** A build stage installs dev dependencies and
  compiles; the runtime stage copies production `node_modules` and the build
  output only.
- **Prisma needs a `DATABASE_URL` to run `prisma generate` at build time.**
  Give it a dummy value in the build stage; the real one arrives at runtime.
- **Migrate on boot, not at build.** The database is not reachable while the
  image builds; run `npx prisma migrate deploy` (or your ORM's equivalent) in
  the entrypoint before starting the server.
- **SQLite lives on a volume.** A database file inside the container
  filesystem is erased by the next deploy.

Prisma's CLI auto-loads `.env` for **every** command, including ones you run
on the host outside Docker: a container-path `DATABASE_URL`
(`file:/data/shop.db`) in `.env` silently breaks host-side
`prisma migrate deploy`. Keep two URLs — the host path in the dockerignored
`.env`, the container path injected at runtime — and never let one masquerade
as the other.

## Rails in Docker

`openreceive-rails → nwc-ruby → rbsecp256k1` compiles libsecp256k1 from
source, so slim images need the autotools in the build stage — without them
`bundle install` fails at `autoreconf: not found`:

```dockerfile
RUN apt-get update && apt-get install -y autoconf automake libtool build-essential pkg-config
```

## Laravel in production

PHP boots the application afresh on every request, so the engine — and the
receive-only wallet preflight its `Service` runs at construction — would run
per request under PHP-FPM or Apache. The package remembers the wallet's info
event in the app's default cache store for
`config('openreceive.wallet_info_cache_seconds')` (600 by default), so a
checkout request costs one relay round trip; the production eager preflight
Rails has happens here on each web boot that misses that cache, and never in
`php artisan config:cache`, `migrate` or the other secretless build commands.
`php artisan config:cache` captures `NWC_URI` / `LSC_URI_*` at cache time —
rebuild it after rotating a code. Migrate in the entrypoint, not at build
(`php artisan migrate --force`); the same secret rules as Node apply to the
image: never `COPY .env`, never an `ENV NWC_URI`. The notifications worker is
`php artisan openreceive:notifications`, one process total, the same image as
the web process with a different command; `ext-pcntl` lets it stop cleanly on
SIGTERM.

## Python (FastAPI) in production

The engine is synchronous by design (one wallet RPC is one blocking call, and
a second async engine would be a second settlement implementation), so the
router's endpoint runs in Starlette's threadpool — the same pool `def`
endpoints use, about 40 threads by default. A slow relay holds a thread for
the service's wallet deadline (10 s) at most; that deadline is the bound, and
there is no OpenReceive knob for the pool. If a busy shop needs more headroom,
raise the pool at startup with anyio (`anyio.to_thread.current_default_thread_limiter().total_tokens = 80`
inside the lifespan) or run more uvicorn workers. Behind a reverse proxy run
uvicorn with `--proxy-headers` so `request.client` — what `rate_limiting`
counts — is the payer, not the proxy.

The same secret rules as Node apply to the image: never `COPY .env`, never an
`ENV NWC_URI`; inject at runtime. Install the engine with `uv` or `pip` on
Python ≥ 3.10 (`pip install "openreceive[fastapi]"`); migrate with the Alembic
revision `openreceive scaffold payments --alembic` emits, in the entrypoint,
not at build.

## Python (Django) in production

`manage.py migrate` applies the engine's shipped migration with your own — in
the entrypoint, not at build. The packaged static checkout
(`{% static "openreceive/openreceive-checkout.js" %}`) ships through
`collectstatic` like any other static file; the notifications worker is
`manage.py openreceive_notifications`, one process total, the same image as
the web process with a different command. The same secret rules as Node apply:
never `COPY .env`, never an `ENV NWC_URI`; inject at runtime.

## Operational monitoring

`attention` rows need an operator. Payers never see them — they still look
like a pending or expired checkout — so alert on them internally:

```sql
SELECT reference, payment_hash, status_reason, expires_at
FROM openreceive_payments
WHERE status = 'attention';
```

Check each in the wallet. If it actually settled, the next reconcile pass
records it. If it is stuck, resolve it wallet-side.

See [Payment storage](storage.md) and [Rate limiting](rate-limiting.md).
