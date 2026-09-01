# Deploying OpenReceive

Every web instance needs the same receive-only NWC configuration and access
to your database. Attempt rows, the settlement claim, and the scan gate all
live there. There is no separate OpenReceive deployment service.

## Multi-instance semantics

Scale web instances freely. Concurrent creates for the same order serialize
in the database. Settlement is write-once. Restarts and overlapping work
repeat bounded, idempotent passes — a payment is never fulfilled twice.

Process-local caches (rates, provider weights) are performance only.
Restarting may cause extra calls, never lost durable truth.

## The durable scan gate

Settlement runs on the request path by default. Every mounted OpenReceive
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
