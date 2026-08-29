# Library-owned persistence boundary

The supported boundary is receive-only NWC invoice creation/verification, stateless mounted
routes, exact fiat conversion, passive notifications plus reconciliation, and optional
server-side swap recovery/refunds.

OpenReceive never owns orders, users, prices, or fulfillment, and never requires a separate
database, Redis, or migration runner. It MAY own payment-attempt rows (`openreceive_payments`)
inside the host application's existing database: the host passes its database handle and runs
the migration through its own workflow; the library owns the schema, locking, settlement
write-once, and the reconciliation state machine. Rails installs the migration via
`openreceive:install` with an engine-owned model; Node apps run
`npx openreceive scaffold payments` (Prisma, Drizzle, TypeORM, Sequelize, or Knex;
`--dialect postgres` or `sqlite`) to emit the migration only. A custom
`PaymentRepository` is the documented escape hatch, never the quickstart.

Each payment row represents one direct payment attempt or one provider swap attempt, with an
explicit status (`pending | settled | expired | failed | attention`). An order has one live
payment session with at most one live attempt per rail/asset. Host sessions, fulfillment state,
and send-payment methods remain outside the product.

The Ruby server is a deliberate second settlement engine, not a port that happens to exist.
Every provider, rate-source, and settlement-rule change is therefore two implementations plus
a conformance-vector update, and that cost is accepted knowingly. It is recorded here so the
decision is re-made on purpose rather than inherited.

## Schema internals

The canonical DDL lives in `@openreceive/core` — `paymentsDdlStatements` in
`payments-ddl.ts`. `paymentsSchemaSql(dialect)` renders it; `npx openreceive
scaffold payments` emits it as a migration. Two CHECK constraints back the
invariants: `status` is one of the five statuses, and `payment_hash` is 64
lowercase hex.

There is deliberately **no** unique index for "one live attempt per rail":
liveness is time-dependent (a superseded or just-expired attempt stays
`pending` until a wallet scan closes it), and uniqueness over pending rows
would reject legitimate reminting. The repository enforces that rule inside
the per-reference commit lock. Generated index names are truncated with a
short digest when a custom table name would push them past Postgres's
63-byte identifier limit.

`openreceive_meta` (`key`, `value`, `rev`) sits next to
`openreceive_payments`. Its `transaction_scan_gate` row is the durable CAS
that serializes opportunistic reconcile. Its `schema_version` row records
which generation is installed (`OPENRECEIVE_PAYMENTS_SCHEMA_VERSION`,
currently `1`).

### Schema version

- **Stored version newer than the library's** — the repository refuses to
  run. Upgrade `@openreceive/http` (or the gem) before pointing it at that
  database.
- **Stored version older** — the library migrates forward once a migration
  for that step exists. Until then version `1` is the only generation.
- **No `schema_version` row** — treated as unversioned, not as a failure. A
  migration emitted by an ORM template that cannot seed rows (Prisma's
  schema file) simply has no marker.

### One engine per table

The two engines write the same fields but not the same schema: the JS DDL
stores timestamps as unix-seconds `BIGINT`s and `checkout_data`/`swap_data`
as `TEXT`, while the Rails engine's migration uses `datetime` columns and
`t.json`. The JS engine serializes `swap_data` with camelCase keys; Ruby
uses snake_case. Point each engine at its own `openreceive_payments` table.
They share the reconcile-gate algorithm, not one physical table.

On SQLite the library sets `PRAGMA busy_timeout` on the handle it is given,
so a commit that races the application's own write waits instead of failing
with `SQLITE_BUSY`.

`checkout_data` stores the complete payer response so a reload re-serves
the same invoice without another wallet call. Re-serve stops at the row's
`expires_at` less a 60-second buffer; after that, create mints a
replacement. On the swap rail that means a late return gets a **new**
deposit address. Reaching one specific attempt after that boundary is
`POST …/swaps/status`, which selects by `payment_hash` and applies no reuse
test.

### Attempt closure

A superseded attempt keeps `pending` (with `status_reason = 'superseded'`)
rather than closing immediately: its invoice stays payable until it expires
wallet-side, so it must stay in the scan set. It is no longer offered to a
payer.

Closing an unpaid attempt requires a successful wallet scan at or after
`expires_at` plus `OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` (900 — an
exported constant, not an environment variable). A local clock alone never
closes a row. A scan that ran out of pages before reaching an attempt is
not a successful scan for that attempt.

Each pass reconciles the oldest `OPENRECEIVE_RECONCILE_BATCH_SIZE` (200)
pending attempts. Vectors:
[`spec/test-vectors/attempt-reconciliation.json`](../../spec/test-vectors/attempt-reconciliation.json).

The integrator-facing schema and status table are in
[Payment storage](../guides/storage.md).
