# Deployment Storage

Integrator basics live in [`docs/guides/storage.md`](../guides/storage.md). This
page is the platform matrix and multi-instance guidance for operators.

## Platform defaults

| Platform | Store guidance |
| --- | --- |
| Vercel, Heroku, Cloud Run, AWS Lambda, DigitalOcean App Platform, Netlify, Cloudflare | Use Postgres. On Vercel, install a Neon Postgres integration from the Vercel Marketplace and use the injected connection string. |
| Render, Railway, Fly.io, Azure App Service, Kubernetes, Dokku, Coolify, CapRover | Use Postgres, or an explicit absolute SQLite path on a durable mounted volume for a single instance. Prefer Postgres on Azure because `/home` is SMB-backed. |
| Raw VPS, Droplet, Hetzner, bare metal | `local-sqlite` is acceptable when the disk is durable and the checkout runs as one instance. |

For platforms without reliable runtime signatures, declare the host with runtime
`OPENRECEIVE_PLATFORM`; it does not select storage by itself. Keep the store URI
in `openreceive.yml`:

```yaml
OPENRECEIVE_STORE: postgres://USER:PASS@HOST:5432/DB
```

## Multi-instance

Use one shared durable OpenReceive store before adding more than one web
process, serverless instance, or any deployment with an ephemeral filesystem.
In v0.1 Node, that shared store is Postgres:

```yaml
OPENRECEIVE_STORE: postgres://openreceive:password@db.example.com:5432/openreceive
OPENRECEIVE_NAMESPACE: prod
```

Do not use a per-instance SQLite file when multiple servers run the same
checkout code.

Do not point OpenReceive at arbitrary app tables, ORM models, object storage,
browser-accessible storage, MySQL, remote SQLite, or platform KV such as
Cloudflare Workers KV unless this package explicitly ships an OpenReceive store
adapter for that backend. The store contains wallet-derived payment state and
must stay server-side.
