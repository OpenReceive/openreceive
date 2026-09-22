# Deployment state

The public [Deploying OpenReceive](../guides/deploying.md) guide covers this material for
integrators. This page keeps the invariants contributors must preserve.

OpenReceive has no separate deployment storage service. To scale out web instances, give each
instance the same receive-only NWC configuration and access to the host database.

Inside the host database it is handed, the library:

- serializes attempt insertion per reference, with a Postgres advisory lock or a SQLite
  immediate transaction,
- enforces a unique `payment_hash`,
- makes settlement write-once.

No reconciler process is required. Every instance takes part in the opportunistic reconcile
that runs on the request path. The instances coordinate through the shared `openreceive_meta`
gate row, which is durable and lives in the host database. That row serializes wallet scans
across instances. The optional notifications worker is one extra process in total, not one per
instance. Passes scan only `pending` attempts, so restarts and overlapping passes repeat
bounded, idempotent work.

Process-local caches for rates, provider weight, and deduplication only improve performance.
Restarting or splitting instances may cause extra calls or duplicate callbacks. It never loses
durable truth.

## When the application boots

Wallet preflight fails closed when the NWC connection is missing or can spend. That means
OpenReceive stops instead of running with that connection.

On Node the adapters run preflight lazily, so the first request awaits it. Await it in a
deploy health check. Express and Next expose a `ready` promise. On Fastify,
`await fastify.ready()` covers it. The Rails engine builds the wallet client and runs
preflight eagerly in production.

### Asset builds are not deploys

`rails assets:precompile` inside an image build counts as a production boot by
`RAILS_ENV`. It runs before any wallet secret is mounted, so preflight there
would fail the **build**. The engine detects this kind of boot by either of two
signals and skips preflight:

- Rails' `SECRET_KEY_BASE_DUMMY`,
- an `assets:precompile` / `assets:clean` / `assets:clobber` rake invocation.

Either way it logs one line. A real production boot with no `NWC_URI`
still fails closed.

For any other boot without secrets, set `config.eager_preflight = false`. It turns off
only the boot check. The wallet is still checked on the first request.

### Where boot failures go

Adapter boot happens before any service exists, so there is no service logger yet.
A boot failure shows up in three ways:

- Every later request answers `503 WALLET_UNAVAILABLE` in the
  OpenReceive JSON error contract. It never returns the raw boot error, because
  that text has not passed through the redaction the service applies elsewhere.
- `await ready` (Express, Next) or `await fastify.ready()` rejects.
- One line goes to `console.error` by default. To route it into your own logger,
  pass `onBootFailure` in the all-in-one adapter options. It receives only
  the message.

[Settlement sweeps](settlement-sweeps.md) covers how the scan-gate interval
stretches, plus timeouts and batching. The deploy page for integrators is
[Deploying OpenReceive](../guides/deploying.md).
