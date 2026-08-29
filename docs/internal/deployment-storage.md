# Deployment state

The integrator-facing version of this material is the public
[Deploying OpenReceive](../guides/deploying.md) guide; this page keeps the
contributor-level invariants.

OpenReceive has no separate deployment storage service. Scaling web instances requires the same
receive-only NWC configuration and access to the host database on each instance.

The library serializes attempt insertion per reference (Postgres advisory lock or SQLite immediate
transaction), enforces unique `payment_hash`, and makes settlement write-once inside the host
database it is handed. No reconciler process is required: every instance participates in
request-path opportunistic reconcile through the shared `openreceive_meta` gate row (durable,
in the host database), which serializes wallet scans across instances; the optional
notifications worker is one extra process, not per-instance. Passes scan only `pending`
attempts, so restarts and overlapping passes repeat bounded, idempotent work.

Process-local rate, provider-weight, and deduplication caches are performance controls only.
Restarting or splitting instances may cause extra calls or duplicate callbacks, never lost
durable truth.

## When the application boots

Wallet preflight fails closed on a missing or spend-capable NWC connection.
On Node the adapters run preflight lazily (the first request awaits it);
await it in a deploy health check — Express and Next expose a `ready`
promise, and on Fastify `await fastify.ready()` covers it. The Rails engine
builds the wallet client — and runs preflight — eagerly in production.

### Asset builds are not deploys

`rails assets:precompile` inside an image build is a production boot by
`RAILS_ENV`, but it runs before any wallet secret is mounted. Preflighting
there would fail the **build**. The engine detects that boot and skips
preflight by two signals: Rails' `SECRET_KEY_BASE_DUMMY`, and an
`assets:precompile` / `assets:clean` / `assets:clobber` rake invocation.
Either way it logs one line. A real production boot with no `NWC_URI`
still fails closed.

For any other secretless boot, `config.eager_preflight = false` turns off
the boot check only; the wallet is still checked on the first request.

### Where boot failures go

Adapter boot happens before any service exists, so it has no service logger.
The failure surfaces three ways:

- Every subsequent request answers `503 WALLET_UNAVAILABLE` in the
  OpenReceive JSON error contract — never the raw boot error, whose text
  has passed through none of the redaction the service applies elsewhere.
- `await ready` (Express, Next) or `await fastify.ready()` rejects.
- One line goes to `console.error` by default. Pass `onBootFailure` in the
  all-in-one adapter options to route it into your own logger; it receives
  the message only.

Scan-gate interval stretching, timeouts, and batching live in
[Settlement sweeps](settlement-sweeps.md). The integrator-facing deploy
page is [Deploying OpenReceive](../guides/deploying.md).
