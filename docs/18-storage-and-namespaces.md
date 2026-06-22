# Storage And Namespaces

OpenReceive owns its invoice storage. Your app should keep orders, carts,
users, fulfillment state, and product data in its own tables, while
OpenReceive keeps invoice rows, idempotency records, lookup gates, sweep
coordination, and settlement-action leases in a package-owned store selected
with `OPENRECEIVE_STORE`.

Do not point OpenReceive at arbitrary app tables, ORM models, object storage,
or browser-accessible storage. The store contains wallet-derived payment state
and must stay server-side.

## Store URI

`OPENRECEIVE_STORE` selects the package-owned invoice KV backend:

| Value | v0.1 status | Notes |
| --- | --- | --- |
| `local-sqlite` | Supported for Node | Creates `./.openreceive/<namespace>.sqlite3`; single-machine only. |
| `sqlite:/path/to/openreceive.sqlite3` | Supported for Node | Explicit local SQLite file. |
| `postgres://...` | Supported for Node | Recommended durable production store for the v0.1 reference path. |
| `memory:` | Tests only | Refused by production demos and deployment helpers. |
| `mysql://...` | Deferred target | Requires a package-owned adapter and storage KV conformance before certification. |
| `redis://...` / `rediss://...` | Deferred target | Requires a package-owned adapter and storage KV conformance before certification. |
| Durable Object binding | Deferred target | Requires a Cloudflare adapter and storage KV conformance before certification. |

MongoDB, Prisma-native models, Drizzle-native models, arbitrary app tables,
S3/object storage, and Workers KV are not supported OpenReceive stores.

## Namespaces

`OPENRECEIVE_NAMESPACE` separates independent OpenReceive installations that
share the same physical store. Use a short, lowercase value such as `default`,
`prod`, or `acme_shop`.

The namespace is operational storage isolation. Each namespace has independent
metadata rows, lookup-rate buckets, recovery sweep clocks, invoice ids,
idempotency keys, and settlement-action leases. Changing the namespace points
OpenReceive at a different logical store inside the same backend.

`merchant_scope` is different. It is an app-level idempotency and tenancy
scope inside one namespace. Use it to distinguish app tenants, checkout
surfaces, or stores that intentionally share the same OpenReceive operational
namespace.

## Ownership Boot

On startup, OpenReceive initializes its own storage schema, records owner and
schema metadata, and refuses to run when the existing store belongs to a
different package or a newer incompatible schema version. Repeated startup is
idempotent; concurrent startup must converge on the same metadata.

Schema creation belongs to the OpenReceive package. App migrations should not
create or alter OpenReceive invoice tables.

## Local SQLite

`local-sqlite` is convenient for demos and single-machine development. It
stores data under `./.openreceive/`, which is gitignored in this repository.
Do not share one local SQLite file across multiple hosts, and do not use it as
durable production storage on ephemeral serverless filesystems.

## Runtime Tuning

The default tuning is conservative. Override these only when your deployment
has measured pressure:

| Variable | Purpose |
| --- | --- |
| `OPENRECEIVE_LOOKUP_BURST` | Maximum immediate backend wallet lookups per namespace. |
| `OPENRECEIVE_LOOKUP_RATE_PER_SEC` | Steady refill rate for lookup gates. |
| `OPENRECEIVE_ACTION_LEASE_TTL_SEC` | Settlement-action lease duration before another process may retry. |
| `OPENRECEIVE_SWEEP_INTERVAL_SEC` | Minimum interval between route-triggered recovery sweeps. |
| `OPENRECEIVE_SWEEP_BATCH` | Maximum invoices examined by one recovery sweep. |
| `OPENRECEIVE_CRON_SECRET` | Shared secret for protected scheduler calls to `/openreceive/v1/poll`. |

OpenReceive does not require a listener, SSE service, webhook bridge, or
background daemon. Interactive lookup routes, route-triggered sweeps, and the
optional protected `/poll` endpoint all coordinate through the durable store.
