# Storage

OpenReceive owns its invoice storage. Your app keeps orders, carts, users,
products, fulfillment state, and tenant-specific columns in your own tables.
Link app records to OpenReceive invoices through your app records or invoice
`orderId`.

## Store URI

Set `OPENRECEIVE_STORE` on the server:

```sh
OPENRECEIVE_STORE=local-sqlite
OPENRECEIVE_NAMESPACE=default
```

Supported v0.1 store values:

| Value | Status | Use |
| --- | --- | --- |
| `local-sqlite` | Supported for Node | Creates `./.openreceive/<namespace>.sqlite3`; with the default namespace this is `./.openreceive/default.sqlite3`. Use for local development and raw single-machine self-hosting. |
| `sqlite:/absolute/path/to/openreceive.sqlite3` | Supported for Node | Uses an explicit SQLite file on one durable machine or one PaaS instance with a real mounted volume. |
| `postgres://...` | Supported for Node | Recommended for production, serverless, managed platforms, and multi-instance deployments. |

Use this store only for OpenReceive invoice state. App migrations should stay
focused on your own app tables.

## Production Storage

Postgres works anywhere and is the recommended default. Most apps already run a
database for orders, customers, or fulfillment, so point `OPENRECEIVE_STORE` at
that durable Postgres database:

```sh
OPENRECEIVE_STORE=postgres://USER:PASS@HOST:5432/DB
```

SQLite is only for one durable machine, such as a raw VPS/Droplet/Hetzner host,
or one PaaS instance with a real mounted volume. It is never safe on ephemeral
serverless filesystems. On mounted-volume platforms, use an explicit absolute
path:

```sh
OPENRECEIVE_STORE=sqlite:/absolute/mounted/volume/openreceive.sqlite3
```

Platform defaults:

| Platform | Store guidance |
| --- | --- |
| Vercel, Heroku, Cloud Run, AWS Lambda, DigitalOcean App Platform, Netlify, Cloudflare | Use Postgres. On Vercel, install a Neon Postgres integration from the Vercel Marketplace and use the injected connection string. |
| Render, Railway, Fly.io, Azure App Service, Kubernetes, Dokku, Coolify, CapRover | Use Postgres, or an explicit absolute SQLite path on a durable mounted volume for a single instance. Prefer Postgres on Azure because `/home` is SMB-backed. |
| Raw VPS, Droplet, Hetzner, bare metal | `local-sqlite` is acceptable when the disk is durable and the checkout runs as one instance. |

For platforms without reliable runtime signatures, declare the host with
`OPENRECEIVE_PLATFORM`; it does not select storage by itself.

```sh
OPENRECEIVE_PLATFORM=aws-apprunner
OPENRECEIVE_STORE=postgres://USER:PASS@HOST:5432/DB

OPENRECEIVE_PLATFORM=coolify
OPENRECEIVE_STORE=sqlite:/app/storage/openreceive.sqlite3
```

## Namespaces

`OPENRECEIVE_NAMESPACE` separates independent OpenReceive installations that
share the same physical store. Use a short, lowercase value such as `default`,
`prod`, or `acme_shop`.

Changing the namespace points OpenReceive at a different logical store inside
the same backend.

OpenReceive uses the namespace as part of the idempotency scope for checkout
invoice rows. Use separate namespaces or separate OpenReceive instances when
two apps should not share replay keys.

## Multi-Instance Choices

Use one shared durable OpenReceive store before adding more than one web
process, serverless instance, or any deployment with an ephemeral filesystem.
In v0.1 Node, that shared store is Postgres:

```sh
OPENRECEIVE_STORE=postgres://openreceive:password@db.example.com:5432/openreceive
OPENRECEIVE_NAMESPACE=prod
```

Do not use a per-instance SQLite file when multiple servers run the same
checkout code.

Do not point OpenReceive at arbitrary app tables, ORM models, object storage,
browser-accessible storage, MySQL, remote SQLite, or platform KV such as
Cloudflare Workers KV unless this package explicitly ships an OpenReceive store
adapter for that backend. The store contains wallet-derived payment state and
must stay server-side.
