# Node ORM recipes

You never write a payment repository by hand. OpenReceive owns the
`openreceive_payments` logic. Your ORM provides two things:

1. **The migration.** `npx openreceive scaffold payments --orm prisma`
   (or `drizzle | typeorm | sequelize | knex`, `--dialect postgres | sqlite`)
   writes one migration or schema file and a wiring guide. The file creates two
   tables, `openreceive_payments` and `openreceive_meta`. Run it with your
   normal migration workflow.
2. **The `db` handle** you pass to `createHost({ db, ... })`.

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

- `dialect` is `"postgres"` or `"sqlite"`.
- `query` runs one statement and returns the SELECT rows (`[]` for other
  statements).
- `transaction` runs a callback against a transactional client.

**Host SQL reaches the driver unchanged.** The library writes each of its own
statements in the dialect you declared: `?` on sqlite, `$1`-style on postgres.
So an adapter passes SQL through exactly as written. A custom adapter must not
rewrite placeholders either. Renumbering `?` to `$1` would break statements
that were already correct. `prismaDb`'s statement router exists to prevent
exactly that failure. See [Storage](storage.md).

You only need a custom adapter for a stack the factories below do not cover.

## Prisma, Knex, TypeORM, Sequelize

`@openreceive/http` ships a named factory for each ORM. The parameter types are
structural, so no ORM dependency is added and your existing handle passes
straight in. `dialect` is a required argument because nothing on the handles
states it reliably. For Prisma, match your datasource provider:

```ts
import { knexDb, prismaDb, sequelizeDb, typeOrmDb } from "@openreceive/http";

createHost({ db: prismaDb(prisma, "postgres"), ... });
createHost({ db: knexDb(knex, "sqlite"), ... });
createHost({ db: typeOrmDb(dataSource, "postgres"), ... });
createHost({ db: sequelizeDb(sequelize, "postgres"), ... });
```

Use the factory for your ORM. Each one makes settlement SQL run in the same
transaction as `onPaid`.

A Prisma trap: the Prisma CLI loads `.env` automatically for every command. If
that file holds a `DATABASE_URL` that points to a container path, migrations run
from the host machine break. See [Deploying → Node in Docker](deploying.md#node-in-docker).

## Schema and `onPaid`

The scaffolded migration renders the canonical DDL in `@openreceive/core`
(`payments-ddl.ts`). `paymentsSchemaSql(dialect)` renders from the same source,
so the two cannot drift apart. Keep every column:

| Column          | Notes                                                        |
| --------------- | ------------------------------------------------------------ |
| `reference`     | Indexed but not unique.                                       |
| `payment_hash`  | Unique. A CHECK constraint enforces 64 lowercase hex.         |
| `status`        | A CHECK constraint limits it to the five statuses.            |
| `status_reason` | Nullable detail for operators.                                |
| `paid_at`       | Nullable, write-once.                                         |
| `expires_at`    | Required.                                                     |
| `created_at`    | The exact time the wallet created the invoice.                |
| `updated_at`    | Set from the local clock.                                     |
| `inserted_at`   | Write-once.                                                   |
| `checkout_data` | The payer-safe JSON snapshot (BOLT11, amount, timestamps).    |
| `swap_data`     | Server-only. Never reaches a serializer, log, or browser.     |
| `client_ip`     | Nullable, with its `(client_ip, inserted_at)` index. Database-backed rate limiting relies on it. |

See [Payment storage](storage.md) for what each column means in full.

The same file also creates `openreceive_meta`. Keep it. The library uses it to
share one wallet scan across every instance. See
[Payment storage](storage.md).

`onPaid({ reference, paymentHash, paidAt, details?, query })` runs inside the
library's settlement transaction. It runs only for the first settled attempt
for a reference. Use `query`, with statements written for your own dialect, to
update your order or insert an outbox row in that transaction. Do not use your
ORM's separate connection there. Never map `swap_data` into an API serializer,
log, or browser bundle.

The "first settled attempt" guarantee covers every settlement path that
OpenReceive owns. It cannot cover fulfillment your application triggers
elsewhere. An admin action, a second payment processor, or a replayed job might
also fulfill an order. If so, they race each other. Make the state change itself
the guard:

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

Every scaffolded file includes a longer version of this note.

Implement the full `PaymentRepository` interface only if no supported handle
or adapter can reach your storage. Pass it as `payments` instead of `db`. This
is an advanced escape hatch, and it makes you responsible for:

- commit locking
- write-once settlement
- reconciliation transitions
- the lease and progress pair `claimReconcileGate` and
  `checkpointReconcileGate`

Setting `opportunisticReconcile: false` turns off only the triggers on
requests. A worker you run explicitly still needs the durable gate.
`recordSettlementWithFulfillment(input, fulfill)` must await `fulfill` with a
typed transaction handle before it commits. Never call it after committing a
boolean claim. See [upgrade and recovery](payment-safety-upgrade.md).
