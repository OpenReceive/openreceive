# Node ORM recipes

You never hand-write a payment repository. OpenReceive owns the
`openreceive_payments` logic; your ORM contributes two things:

1. **The migration.** `npx openreceive scaffold payments --orm prisma`
   (or `drizzle | typeorm | sequelize | knex`, `--dialect postgres | sqlite`)
   emits one migration/schema file — `openreceive_payments` and the sibling
   `openreceive_meta` reconcile gate together — plus a wiring guide. Run it
   through your normal migration workflow.
2. **The `db` handle** passed to `createHost({ db, ... })`.

## What to pass as `db`

| Stack                  | Pass                                                        |
| ---------------------- | ----------------------------------------------------------- |
| pg (node-postgres)     | the `Pool` or `Client` directly                             |
| node:sqlite            | the `DatabaseSync` directly                                 |
| better-sqlite3         | the `Database` directly                                     |
| Drizzle                | the underlying driver (`pg` Pool or better-sqlite3) directly |
| Prisma                 | `prismaDb(prisma, dialect)` from `@openreceive/http`        |
| Knex                   | `knexDb(knex, dialect)` from `@openreceive/http`            |
| TypeORM                | `typeOrmDb(dataSource, dialect)` from `@openreceive/http`   |
| Sequelize              | `sequelizeDb(sequelize, dialect)` from `@openreceive/http`   |

A custom adapter is `{ dialect, query, transaction }` (`SqlAdapter`):
`dialect` is `"postgres"` or `"sqlite"`, `query` runs one statement and returns
SELECT rows (`[]` otherwise), and `transaction` runs a callback against a
transactional client.

**Host SQL reaches the driver verbatim.** The library renders each statement in
the dialect you declared — `?` on sqlite, `$1`-style on postgres — so an
adapter passes SQL through as written. A custom adapter must not rewrite
placeholders either: renumbering `?` to `$1` would corrupt statements that were
already correct, which is exactly the failure `prismaDb`'s statement router
exists to prevent. See [Storage](storage.md).

You only write a custom adapter for a stack the factories below don't cover.

## Prisma, Knex, TypeORM, Sequelize

`@openreceive/http` ships a named factory per ORM. The parameter types are
structural, so no ORM dependency is added and your existing handle passes
straight in. `dialect` is a required argument because nothing on the handles
states it reliably — for Prisma, match your datasource provider:

```ts
import { knexDb, prismaDb, sequelizeDb, typeOrmDb } from "@openreceive/http";

createHost({ db: prismaDb(prisma, "postgres"), ... });
createHost({ db: knexDb(knex, "sqlite"), ... });
createHost({ db: typeOrmDb(dataSource, "postgres"), ... });
createHost({ db: sequelizeDb(sequelize, "postgres"), ... });
```

Use the factory for your ORM. Each one makes settlement SQL run on the
same transaction as `onPaid`.

## Schema and `onPaid`

The scaffolded migration renders the canonical DDL in `@openreceive/core`
(`payments-ddl.ts` — the same source `paymentsSchemaSql(dialect)` renders, so
the two cannot drift). Keep every column:

| Column          | Notes                                                        |
| --------------- | ------------------------------------------------------------ |
| `reference`     | Indexed but not unique.                                       |
| `payment_hash`  | Unique; CHECK enforces 64 lowercase hex.                      |
| `status`        | CHECK over the five statuses.                                 |
| `status_reason` | Nullable operator-facing detail.                              |
| `paid_at`       | Nullable, write-once.                                         |
| `expires_at`    | Required.                                                     |
| `created_at`    | The wallet's exact mint time.                                 |
| `updated_at`    | Locally clocked.                                              |
| `inserted_at`   | Write-once.                                                   |
| `checkout_data` | The payer-safe JSON snapshot (BOLT11, amount, timestamps).    |
| `swap_data`     | Server-only — never reaches a serializer, log, or browser.    |
| `client_ip`     | Nullable, with its `(client_ip, inserted_at)` index — DB-backed rate limiting counts on it. |

See [Payment storage](storage.md) for the full column semantics.

The same file also creates `openreceive_meta`. Keep it — the library uses it
to share one wallet scan across every instance. See
[Payment storage](storage.md).

`onPaid({ reference, paymentHash, paidAt, details?, query })` runs inside the
library's settlement transaction, only for the first settled attempt for a reference.
Use `query` (statements written for your own dialect) to update your order or insert an outbox
row transactionally — do not use your ORM's separate connection there. Never
map `swap_data` into an API serializer, log, or browser bundle.

That "first settled attempt" guarantee covers every settlement path OpenReceive
owns; it cannot cover fulfillment your application triggers elsewhere. If an
admin action, a second processor, or a replayed job can also fulfill an order,
those race each other — so make the transition itself the guard:

```ts
const onPaid = async ({ reference, paidAt, query }) => {
  const claimed = await query(
    `UPDATE orders SET state = 'paid', paid_at = $1
      WHERE id = $2 AND state = 'awaiting_payment' RETURNING id`,
    [paidAt, reference],
  );
  if (claimed.length === 0) return; // someone else already fulfilled it
  // Same transaction: enqueue the shipping/email work rather than doing it
  // inline. Anything that reaches outside the transaction survives a rollback
  // and runs again on the retry.
  await query("INSERT INTO outbox (kind, reference) VALUES ($1, $2)", ["order_paid", reference]);
};
```

Every scaffolded file carries the long-form version of this note.

Only if no supported handle or adapter can reach your persistence, implement
the full `PaymentRepository` interface and pass it as `payments`
instead of `db`; that advanced escape hatch makes you responsible for commit
locking, write-once settlement, and reconciliation transitions. It must also
implement `claimReconcileGate({ now, intervalSeconds })` — construction throws
unless you do, or pass `opportunisticReconcile: false` because your own worker
runs settlement.
