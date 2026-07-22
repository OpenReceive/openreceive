# Deployment Storage

Integrator basics live in [`docs/guides/storage.md`](../guides/storage.md). This
page is the platform matrix and multi-instance guidance for operators.

## Store resolution

When `store` is omitted at runtime / CLI:

1. Postgres `DATABASE_PRIVATE_URL` (if set)
2. else Postgres `DATABASE_URL` (if set)
3. else `local-sqlite` — only where the platform policy allows durable local files

Heroku, Vercel, Cloud Run, Lambda, and similar hosts refuse implicit SQLite with
`EPHEMERAL_STORE_UNSAFE`. On those platforms, a Postgres `DATABASE_URL` (addon /
Marketplace injection) is enough; you do not need to duplicate it as
`store`. Boot logs `store.resolved` with `source` /
`store_kind` so operators can confirm what was chosen.

Explicit `store` always wins. Non-Postgres `DATABASE_URL` values are
ignored.

## Platform defaults

| Platform | Store guidance |
| --- | --- |
| Vercel, Heroku, Cloud Run, AWS Lambda, DigitalOcean App Platform, Netlify, Cloudflare | Use Postgres. A Postgres `DATABASE_URL` is adopted automatically. On Vercel, install a Neon (or other Marketplace Postgres) integration and rely on the injected connection string. |
| Render, Railway, Fly.io, Azure App Service, Kubernetes, Dokku, Coolify, CapRover | Prefer Postgres via `DATABASE_URL`, or set an explicit absolute SQLite path on a durable mounted volume for a single instance. Prefer Postgres on Azure because `/home` is SMB-backed. |
| Raw VPS, Droplet, Hetzner, bare metal | `local-sqlite` is acceptable when the disk is durable and the checkout runs as one instance; otherwise use Postgres. |

For platforms without reliable runtime signatures, declare the host with runtime
`OPENRECEIVE_PLATFORM`; it does not select storage by itself. Override the store
only when you need a URI other than `DATABASE_URL`:

```yaml
store: postgres://USER:PASS@HOST:5432/DB
```

## Multi-instance

Use one shared durable OpenReceive store before adding more than one web
process, serverless instance, or any deployment with an ephemeral filesystem.
In v0.1 Node, that shared store is Postgres — typically the same
`DATABASE_URL` your app already uses (OpenReceive tables are namespaced and
do not replace app migrations):

```yaml
# Optional: omit store when DATABASE_URL is already Postgres.
store: postgres://openreceive:password@db.example.com:5432/openreceive
namespace: prod
```

Run `openreceive migrate` once against that store before boot. OpenReceive does
not auto-migrate Postgres on startup.

Do not use a per-instance SQLite file when multiple servers run the same
checkout code.

Do not point OpenReceive at arbitrary app tables, ORM models, object storage,
browser-accessible storage, MySQL, remote SQLite, or platform KV such as
Cloudflare Workers KV unless this package explicitly ships an OpenReceive store
adapter for that backend. The store contains wallet-derived payment state and
must stay server-side.
