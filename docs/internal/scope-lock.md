# Library-owned persistence boundary

OpenReceive supports exactly this scope:

- creating and verifying invoices over receive-only NWC,
- stateless mounted routes,
- exact fiat conversion,
- passive notifications plus reconciliation,
- optional server-side swap recovery and refunds.

OpenReceive never owns orders, users, prices, or fulfillment. It never requires a separate
database, Redis, or migration runner. It MAY own payment-attempt rows (`openreceive_payments`)
inside the host application's existing database. In that case:

- The host passes its database handle and runs the migration with its own tooling.
- The library owns the schema, locking, write-once settlement, and the reconciliation state
  machine.
- Rails installs the migration with `openreceive:install`, and the engine owns the model.
- Node apps run `npx openreceive scaffold payments` to emit only the migration. It supports
  Prisma, Drizzle, TypeORM, Sequelize, or Knex, with `--dialect postgres` or `sqlite`.

A custom `PaymentRepository` is the documented escape hatch. It is never the quickstart path.

Each payment row is either one direct payment attempt or one provider swap attempt. It has an
explicit status (`pending | settled | expired | failed | attention`). An order has one live
payment session, with at most one live attempt per rail or asset. Host sessions, fulfillment
state, and send-payment methods stay outside the product.

The Ruby server is a deliberate second settlement engine, not a port that happens to exist.
So every change to a provider, rate source, or settlement rule means two implementations plus
a conformance-vector update. We accept that cost knowingly. It is written down here so that
anyone revisiting the decision makes it again on purpose instead of inheriting it.

The BTCPay Server plugin (`packages/dotnet`, C#) is a deliberate third settlement engine,
decided 2026-09-03. It ports the kernel rows in `conformance.md` against the shared vectors.
Its host glue is written against BTCPay 2.4.4. Every kernel change is now three
implementations plus a vector update. This engine differs in two ways, and we accept both on
purpose.

First, it owns no `openreceive_payments` table and no reconcile gate. BTCPay's invoices are the
reference, and BTCPay's payments are the settlement record. The gate survives only as the
in-memory `ScanMemo` (`settlement-sweeps.md`). The plugin has two tables inside BTCPay's
Postgres, which BTCPay migrates at startup:

- `openreceive_invoices` records what the plugin minted: hash, creation time and expiry time.
  These are the scan inputs a restart must not lose.
- `openreceive_swaps`.

Second, it is the first and only engine that emits the attention reason
`provider_completed_without_wallet_settlement`. That reason stays `reserved` in
`spec/data/kernel-tables.json`. The plugin's poller flags a swap when the provider reports
`completed` but the Lightning side has not settled within 30 minutes. The JS and Ruby engines
make no such time-based transition. We record the difference here instead of hiding it. If
either of those engines gains the transition, the reason loses its reserved flag and gains a
decision-table vector.

The PHP engine (`packages/php`: Composer `openreceive/openreceive` + `openreceive/laravel`) is a
deliberate fourth settlement engine, decided 2026-09-06 and built 2026-09-07. It:

- ports every kernel row against the shared vectors;
- owns its own `openreceive_payments` / `openreceive_meta` tables in the host's database, in
  the Rails shape with snake_case `swap_data` (one engine per table still holds);
- reaches the database through a five-method `DatabaseConnection` interface, so the
  WordPress plugin can drive it over `$wpdb`;
- depends on `dsbaars/nostr-php-nwc` for NIP-47, with an in-repo NWC-02 listener.

Every kernel change is now four implementations plus a vector update.

The Python engine (`packages/python`: one PyPI distribution `openreceive` with `[django]` and
`[fastapi]` extras) is a deliberate fifth settlement engine, decided 2026-09-06 and built
2026-09-07. It:

- is synchronous by design, to fit the Django ORM, Flask, and one blocking wallet RPC.
  FastAPI mounts the sync handler in threadpool endpoints.
- carries its own NWC transport (`openreceive.nwc.transport`, NIP-01/NIP-44/NIP-04 over a
  synchronous websocket) instead of depending on a binding;
- keeps two repository backends, SQLAlchemy Core and the Django ORM, behind one
  `PaymentRepository` protocol.

Every kernel change is now five implementations plus a vector update. We accept that cost
knowingly.

## Schema internals

The canonical DDL (the table definitions) lives in `@openreceive/core`, as
`paymentsDdlStatements` in `payments-ddl.ts`. `paymentsSchemaSql(dialect)` renders it.
`npx openreceive scaffold payments` emits it as a migration. Two CHECK constraints enforce
the invariants: `status` is one of the five statuses, and `payment_hash` is 64
lowercase hex characters.

There is deliberately **no** unique index for "one live attempt per rail".
Whether an attempt is live depends on time. A superseded or just-expired attempt stays
`pending` until a wallet scan closes it. A unique index over pending rows
would therefore reject legitimate reminting. The repository enforces the rule inside
the per-reference commit lock instead.

If a custom table name would push a generated index name past Postgres's
63-byte identifier limit, the name is truncated and a short digest is appended.

`openreceive_meta` (`key`, `value`, `rev`) sits next to
`openreceive_payments`. Its `transaction_scan_gate` row is the durable compare-and-swap
(CAS) row that makes opportunistic reconcile passes run one at a time. Its `schema_version`
row records which schema generation is installed (`OPENRECEIVE_PAYMENTS_SCHEMA_VERSION`,
currently `1`).

### Schema version

- **Stored version newer than the library's:** the repository refuses to
  run. Upgrade `@openreceive/http` (or the gem) before pointing it at that
  database.
- **Stored version older:** the library migrates forward once a migration
  for that step exists. Until then, version `1` is the only generation.
- **No `schema_version` row:** treated as unversioned, not as a failure. Some ORM
  templates cannot seed rows, such as Prisma's schema file. A migration emitted by one of
  them simply has no marker.

### One engine per table

The two engines write the same fields but not the same schema. The JS DDL
stores timestamps as unix-seconds `BIGINT`s and `checkout_data`/`swap_data`
as `TEXT`. The Rails engine's migration uses `datetime` columns and
`t.json`. The JS engine serializes `swap_data` with camelCase keys, and Ruby
uses snake_case. Point each engine at its own `openreceive_payments` table.
They share the reconcile-gate algorithm, not one physical table.

On SQLite the library sets `PRAGMA busy_timeout` on the handle it is given.
A commit that races the application's own write then waits instead of failing
with `SQLITE_BUSY`.

`checkout_data` stores the complete payer response, so a reload serves
the same invoice again without another wallet call. This stops 60 seconds before the row's
`expires_at`. After that, create mints a replacement. On the swap rail, a payer who
returns late therefore gets a **new** deposit address. To reach one specific attempt after
that point, call `POST …/swaps/status`. It selects by `payment_hash` and applies no reuse
test.

### Attempt closure

A superseded attempt stays `pending`, with `status_reason = 'superseded'`.
It does not close immediately, because its invoice stays payable until it expires
in the wallet. It must therefore stay in the scan set. It is no longer offered to a
payer.

Closing an unpaid attempt requires a successful wallet scan at or after
`expires_at` plus `OPENRECEIVE_ATTEMPT_EXPIRY_GRACE_SECONDS` (900). That value is an
exported constant, not an environment variable. A local clock alone never
closes a row. If a scan ran out of pages before it reached an attempt, it does not count
as a successful scan for that attempt.

Each pass reconciles the oldest `OPENRECEIVE_RECONCILE_BATCH_SIZE` (200)
pending attempts. Vectors:
[`spec/test-vectors/attempt-reconciliation.json`](../../spec/test-vectors/attempt-reconciliation.json).

The integrator-facing schema and status table are in
[Payment storage](../guides/storage.md).

The WooCommerce plugin in `packages/php/wordpress` is a host integration on top of the
PHP engine, which it shares with Laravel. It does not add another settlement engine.
WooCommerce owns order state, prices, stock and email. The plugin commits only
payment metadata. It uses a durable completion marker to repair `payment_complete` calls
that were interrupted after the commit. Its Docker example lives in
`examples/wordpress`.
