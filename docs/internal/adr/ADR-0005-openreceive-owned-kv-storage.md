# ADR-0005: OpenReceive-Owned KV Storage

## Status

Accepted for v0.1-v2.

## Context

Framework ORM models make invoice lifecycle logic multiply across adapters and
make correctness depend on app migrations. OpenReceive needs one durable
coordination point that works across web processes and replicas.

## Decision

OpenReceive owns its invoice storage through a 9-method KV contract. Apps
select a transport with `OPENRECEIVE_STORE` and optionally isolate instances
with `OPENRECEIVE_NAMESPACE`.

OpenReceive self-initializes supported stores. SQL adapters use OpenReceive
tables with uniqueness/recovery control columns and an opaque record blob. Apps
keep business data in app-owned tables and link through metadata or their own
records.

### Amendment (DATABASE_URL auto-adopt)

When `OPENRECEIVE_STORE` is omitted, Node resolves a Postgres
`DATABASE_PRIVATE_URL` or `DATABASE_URL` before falling back to `local-sqlite`.
This does not change ownership of the KV contract or allow framework ORM invoice
models — it only picks the transport URI. Postgres still requires an explicit
`openreceive migrate` (schema mode `check` at boot). See
[Storage](../../guides/storage.md) and
[Deployment Storage](../deployment-storage.md).

## Consequences

- Framework packages do not ship app ORM invoice models.
- Store adapters do not implement lifecycle transitions.
- Unsupported user tables, Prisma-native models, Drizzle-native models,
  ActiveRecord invoice models, and similar framework-native storage are outside
  the v0.1 contract.
- Hosts that already inject `DATABASE_URL` (Heroku, Railway, Render, Neon on
  Vercel, …) need not duplicate that URI as `OPENRECEIVE_STORE`.
