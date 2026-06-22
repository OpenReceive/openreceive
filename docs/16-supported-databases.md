# Supported Databases

OpenReceive owns its invoice persistence. Applications keep orders, carts,
users, products, fulfillment state, and tenant-specific columns in their own
tables. OpenReceive stores invoice records as opaque package-owned KV records
with a small set of control indexes for idempotency, lookup, recovery, and
settlement-action leases.
Apps keep business data in app-owned tables and link to OpenReceive invoices
through metadata or their own records.

A storage target is supported only when OpenReceive ships all three pieces:

- a package-owned KV adapter
- package-owned schema initialization
- conformance coverage for idempotency, recovery, lookup gates, and settlement
  transitions

## Matrix

| Runtime | Store URI | Status | Intended Use |
| --- | --- | --- | --- |
| Node | `local-sqlite` | Supported | Single-machine self-hosting, demos, local development |
| Node | `sqlite:/path/to/openreceive.sqlite3` | Supported | Explicit local SQLite files |
| Node | `postgres://...` | Supported | Production and reference deployments |
| Node | `memory:` | Tests only | Unit tests and throwaway local experiments |
| Node | `mysql://...` | Deferred | Future transport target; not certified in v0.1 |
| Node | `redis://...` / `rediss://...` | Deferred | Future transport target; not certified in v0.1 |
| Cloudflare | Durable Object binding | Deferred | Future serverless transport target; not certified in v0.1 |

`InMemoryInvoiceKvStore` is for tests and throwaway demos only. Node and
Express refuse memory storage in production mode.

MongoDB, Prisma-native models, Drizzle-native models, arbitrary user tables,
S3/object storage, and Cloudflare Workers KV are not supported storage targets.
MySQL, Redis/Upstash, and Cloudflare Durable Object storage remain transport
targets only after they ship package-owned adapters and pass the storage KV
conformance vector. Prisma and Drizzle recipes may wrap the package-owned SQL
schema later, but they must not reinvent invoice rows as app-owned models.

`OPENRECEIVE_STORE` selects the transport. `OPENRECEIVE_NAMESPACE` scopes table
or key prefixes when multiple OpenReceive instances share one store. Supported
adapters self-initialize their package-owned schema on boot.
