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

The package self-initializes supported stores. SQL adapters use package-owned
tables with uniqueness/recovery control columns and an opaque record blob. Apps
keep business data in app-owned tables and link through metadata or their own
records.

## Consequences

- Framework packages do not ship app ORM invoice models.
- Store adapters do not implement lifecycle transitions.
- Unsupported user tables, Prisma-native models, Drizzle-native models,
  ActiveRecord invoice models, and similar framework-native storage are outside
  the v0.1 contract.
