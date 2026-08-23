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
| Prisma, Knex, TypeORM  | a small custom adapter (recipes below)                      |
| Sequelize              | a separate `pg` Pool to the same database, or an adapter like TypeORM's |

A custom adapter is `{ dialect, query, transaction }`
(`SqlAdapter`): `dialect` is `"postgres"` or `"sqlite"`, `query`
runs one statement with `?` placeholders and returns SELECT rows (`[]`
otherwise), and `transaction` runs a callback against a transactional client.
Postgres drivers need `?` rewritten to `$1`-style.

## Prisma

```ts
import type { PrismaClient } from "@prisma/client";
import type { SqlAdapter, SqlQuery } from "@openreceive/http";

type Tx = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;

export function prismaDb(
  prisma: PrismaClient,
  dialect: "postgres" | "sqlite", // match your Prisma datasource provider
): SqlAdapter {
  // SQL arrives already written for `dialect` — pass it through verbatim.
  const queryOn = (tx: Tx): SqlQuery => async (sql, params = []) => {
    if (/^\s*select/i.test(sql)) {
      return (await tx.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[];
    }
    await tx.$executeRawUnsafe(sql, ...params);
    return [];
  };
  return {
    dialect,
    query: queryOn(prisma),
    transaction: (run) => prisma.$transaction((tx) => run({ query: queryOn(tx) })),
  };
}
```

## Knex

Knex already uses `?` bindings; only the result shape differs per driver.

```ts
import type { Knex } from "knex";
import type { SqlAdapter, SqlQuery } from "@openreceive/http";

export function knexDb(knex: Knex, dialect: "postgres" | "sqlite"): SqlAdapter {
  const queryOn = (executor: Knex | Knex.Transaction): SqlQuery =>
    async (sql, params = []) => {
      // SQL arrives already written for `dialect`; only the RESULT shape differs.
      const result = await executor.raw(sql, [...params] as Knex.RawBinding[]);
      // The sqlite3 driver resolves the rows array itself; pg wraps them in
      // `{ rows }`. Reaching into `result[0]` returns the first ROW on sqlite,
      // which breaks every repository read.
      return dialect === "sqlite"
        ? (result as Record<string, unknown>[])
        : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
    };
  return {
    dialect,
    query: queryOn(knex),
    transaction: (run) => knex.transaction((trx) => run({ query: queryOn(trx) })),
  };
}
```

## TypeORM

```ts
import type { DataSource } from "typeorm";
import type { SqlAdapter, SqlQuery } from "@openreceive/http";

export function typeOrmDb(
  dataSource: DataSource,
  dialect: "postgres" | "sqlite",
): SqlAdapter {
  // SQL arrives already written for `dialect` — pass it through verbatim.
  const queryOn = (runner: { query(sql: string, params?: unknown[]): Promise<unknown> }): SqlQuery =>
    async (sql, params = []) =>
      ((await runner.query(sql, [...params])) ?? []) as Record<string, unknown>[];
  return {
    dialect,
    query: queryOn(dataSource),
    // Run through the transaction's own manager. Falling back to `dataSource`
    // would execute settlement statements outside the transaction.
    transaction: (run) => dataSource.transaction((manager) => run({ query: queryOn(manager) })),
  };
}
```

## Schema and `onPaid`

The scaffolded migration renders the canonical DDL in `@openreceive/core`
(`payments-ddl.ts` — the same source `paymentsSchemaSql(dialect)`
renders, so the two cannot drift): `order_id` indexed but not unique,
`payment_hash` unique (64-lowercase-hex CHECK), `status` (CHECK over the five
statuses) + `status_reason`, `paid_at`, `expires_at`, exact wallet
`created_at`, locally-clocked `updated_at`, write-once `inserted_at`,
`checkout_data`, server-only `swap_data`, and
nullable `client_ip` (with its `(client_ip, inserted_at)` index — DB-backed
rate limiting counts on it). Keep every column. `order_id` is always `TEXT`
with no foreign key: OpenReceive never reads, writes, locks, or joins your
order table, so its name and primary-key type never enter the schema. See
[Payment storage](storage.md).

The same file also creates `openreceive_meta` (`key`, `value`, `rev`) in the
same database — one migration, both tables — and, where the ORM's migration
format can seed rows, seeds its `schema_version` marker (see
[Payment storage](storage.md#schema-version)). The `transaction_scan_gate` row is
the durable claim that collapses the request-path reconcile passes of every
instance into one wallet scan per interval, so keep it even though no code of yours
touches it.

`onPaid({ orderId, paymentHash, paidAt, details?, query })` runs inside the
library's settlement transaction, only for the order's first settled attempt.
Use `query` (same `?` placeholders) to update your order or insert an outbox
row transactionally — do not use your ORM's separate connection there. Never
map `swap_data` into an API serializer, log, or browser bundle.

That "first settled attempt" guarantee covers every settlement path OpenReceive
owns; it cannot cover fulfillment your application triggers elsewhere. If an
admin action, a second processor, or a replayed job can also fulfill an order,
those race each other — so make the transition itself the guard:

```ts
const onPaid = async ({ orderId, paidAt, query }) => {
  const claimed = await query(
    `UPDATE orders SET state = 'paid', paid_at = $1
      WHERE id = $2 AND state = 'awaiting_payment' RETURNING id`,
    [paidAt, orderId],
  );
  if (claimed.length === 0) return; // someone else already fulfilled it
  await shipOrder(orderId);
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
