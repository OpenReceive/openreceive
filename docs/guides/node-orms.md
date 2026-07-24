# Node ORM recipes

Prefer the scaffolder when starting from scratch:

```sh
npx openreceive scaffold payments
npx openreceive scaffold payments --orm prisma
npx openreceive scaffold payments --orm drizzle
npx openreceive scaffold payments --orm typeorm
npx openreceive scaffold payments --orm sequelize
npx openreceive scaffold payments --orm knex
npx openreceive scaffold payments --orm knex --dialect sqlite
```

That writes the host-owned schema plus repository, settlement, and hook stubs.
Pass `--dialect sqlite` for local SQLite (single-writer transactions, no
`SELECT … FOR UPDATE`); the default dialect is `postgres`.
The recipes below are the same shapes for hand edits or review.

OpenReceive does not need its own database connection. Add one host-owned
`openreceive_payments` model to the ORM your application already uses. Each row
is one invoice or swap attempt, so `order_id` is indexed but deliberately not
unique.

One row has at most one provider swap attempt. A swap retry inserts another row
with a fresh `payment_hash`; do not attach several provider orders or deposit
addresses to one Lightning invoice.

Retrying a status lookup, checkout read, or refund call does not create another
attempt; those operations continue to use the same row and provider order.
Only a newly created provider order requires a new payment row.

## Canonical model

```text
id            primary key
order_id      required, indexed, foreign key when practical
payment_hash  required, unique, 64 lowercase hex characters
paid_at       nullable timestamp
expires_at    required timestamp
checkout_data required JSON, safe payer response
swap_data     nullable JSON/text, server-only
created_at    required exact wallet invoice creation timestamp
updated_at    required timestamp
```

`paid_at = null` means only “this attempt has not settled.” It does not imply
that the attempt is live: an unpaid row can be pending, expired, failed, or
abandoned. Creation may reuse only an unpaid attempt whose payer instructions
have not expired and whose refreshed wallet/provider state remains reusable.

Never put `swap_data` in an API serializer, application log, error object,
fixture, or browser bundle. It can contain a provider credential.

## Host integration

`@openreceive/http` keeps selection logic independent of the ORM:

```ts
import {
  createOpenReceiveHost,
  openReceivePaymentInsert,
  type OpenReceiveHostRepository,
} from "@openreceive/http";

const payments: OpenReceiveHostRepository = {
  async listForOrder(orderId) {
    // Return all attempts for this order as:
    // { orderId, paymentHash, paidAt, expiresAt, createdAt, checkout, swapData? }
    return paymentRepository.listForOrder(orderId);
  },

  async commitAttempt(input) {
    const values = openReceivePaymentInsert(input);
    await paymentRepository.commitWhileLockingOrder(values);
  },

  listUnsettledAttempts: () => paymentRepository.listUnsettledAttempts(),
};

export const host = createOpenReceiveHost({
  loadOrder: (orderId) => orderRepository.find(orderId),
  amountForOrder: (order) => ({
    currency: order.currency,
    value: order.total.toString(),
  }),
  payments,
  onPaid: ({ paymentHash, paidAt }) =>
    paymentRepository.markPaidOnceAndFulfillFirst(paymentHash, paidAt),
});
```

Mount with:

```ts
app.use(openReceiveExpress({
  service,
  authorize,
  host,
}));
```

`commitWhileLockingOrder` is the only ORM-specific critical section. In one
database transaction it must:

1. lock the host order row;
2. return successfully if the same `payment_hash` is already stored;
3. reject if any attempt for the order is already paid;
4. reject if another unpaid attempt has `expires_at > now`;
5. insert the new row;
6. commit before returning.

Throwing causes the mounted handler to return `409` without exposing the losing
invoice. PostgreSQL/MySQL applications normally use `SELECT ... FOR UPDATE`.
SQLite applications use their ORM's serialized write transaction.

Pass `--dialect sqlite` to the scaffolder for SQLite-safe schema types and
locking (no `FOR UPDATE` / `pessimistic_write`). Local demos wipe a host-owned
SQLite file on boot and recreate `orders` + `openreceive_payments`; that is
ordinary host code, not OpenReceive runtime storage.

## Prisma

Change the `orderId` type to match the host `Order` primary key:

```prisma
model OpenReceivePayment {
  id          String    @id @default(cuid())
  orderId     String    @map("order_id")
  order       Order     @relation(fields: [orderId], references: [id], onDelete: Restrict)
  paymentHash String    @unique @db.VarChar(64) @map("payment_hash")
  paidAt      DateTime? @map("paid_at")
  expiresAt   DateTime  @map("expires_at")
  checkoutData Json     @map("checkout_data")
  swapData    Json?     @map("swap_data")
  createdAt   DateTime  @map("created_at")
  updatedAt   DateTime  @updatedAt @map("updated_at")

  @@index([orderId, createdAt])
  @@index([paidAt, createdAt])
  @@map("openreceive_payments")
}
```

The commit transaction should lock `Order` before reading attempts:

```ts
await prisma.$transaction(async (tx) => {
  await tx.$queryRaw`
    SELECT id FROM "Order" WHERE id = ${values.orderId} FOR UPDATE
  `;

  const same = await tx.openReceivePayment.findUnique({
    where: { paymentHash: values.paymentHash },
  });
  if (same) return;

  const existing = await tx.openReceivePayment.findFirst({
    where: {
      orderId: values.orderId,
      OR: [
        { paidAt: { not: null } },
        { paidAt: null, expiresAt: { gt: new Date() } },
      ],
    },
  });
  if (existing) throw new Error("Order already has a paid or live payment attempt.");

  await tx.openReceivePayment.create({
    data: {
      orderId: values.orderId,
      paymentHash: values.paymentHash,
      expiresAt: new Date(values.expiresAt * 1000),
      createdAt: new Date(values.createdAt * 1000),
      checkoutData: values.checkout,
      swapData: values.swapData,
    },
  });
});
```

Keep the raw lock query static and parameterized. If the host uses a mapped
table name, update `"Order"` to that fixed table name.

## Drizzle

PostgreSQL schema:

```ts
import {
  bigint,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const openReceivePayments = pgTable(
  "openreceive_payments",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orderId: bigint("order_id", { mode: "number" })
      .notNull()
      .references(() => orders.id, { onDelete: "restrict" }),
    paymentHash: varchar("payment_hash", { length: 64 }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    checkoutData: jsonb("checkout_data").notNull(),
    swapData: jsonb("swap_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("openreceive_payments_hash_uidx").on(table.paymentHash),
    index("openreceive_payments_order_created_idx").on(table.orderId, table.createdAt),
    index("openreceive_payments_paid_created_idx").on(table.paidAt, table.createdAt),
  ],
);
```

Inside `db.transaction`, lock the order with a parameterized
`select id from orders where id = ? for update`, perform the paid/live checks,
and insert.

## TypeORM

```ts
@Entity({ name: "openreceive_payments" })
@Index(["orderId", "createdAt"])
@Index(["paidAt", "createdAt"])
export class OpenReceivePayment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "order_id" })
  orderId!: string;

  @ManyToOne(() => Order, { onDelete: "RESTRICT" })
  @JoinColumn({ name: "order_id" })
  order!: Order;

  @Column({ name: "payment_hash", length: 64, unique: true })
  paymentHash!: string;

  @Column({ name: "paid_at", type: "timestamp", nullable: true })
  paidAt!: Date | null;

  @Column({ name: "expires_at", type: "timestamp" })
  expiresAt!: Date;

  @Column({ name: "checkout_data", type: "json" })
  checkoutData!: unknown;

  @Column({ name: "swap_data", type: "json", nullable: true, select: false })
  swapData!: unknown | null;

  @Column({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}
```

Use a transaction query runner and load `Order` with
`lock: { mode: "pessimistic_write" }` before checking and inserting attempts.
`select: false` prevents accidental ordinary reads of `swap_data`; explicitly
select it only inside the server-side OpenReceive repository.

## Sequelize

```ts
OpenReceivePayment.init({
  id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
  orderId: { type: DataTypes.BIGINT, allowNull: false, field: "order_id" },
  paymentHash: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
    field: "payment_hash",
  },
  paidAt: { type: DataTypes.DATE, allowNull: true, field: "paid_at" },
  expiresAt: { type: DataTypes.DATE, allowNull: false, field: "expires_at" },
  checkoutData: { type: DataTypes.JSON, allowNull: false, field: "checkout_data" },
  swapData: { type: DataTypes.JSON, allowNull: true, field: "swap_data" },
  createdAt: { type: DataTypes.DATE, allowNull: false, field: "created_at" },
}, {
  sequelize,
  tableName: "openreceive_payments",
  underscored: true,
  defaultScope: { attributes: { exclude: ["swapData"] } },
  indexes: [
    { fields: ["order_id", "created_at"] },
    { fields: ["paid_at", "created_at"] },
  ],
});
```

Within `sequelize.transaction`, load the order using
`lock: transaction.LOCK.UPDATE`. Explicitly remove `swapData` from any
application serializer even though the default scope excludes it.

## Knex

```ts
export async function up(knex) {
  await knex.schema.createTable("openreceive_payments", (table) => {
    table.bigIncrements("id").primary();
    table.bigInteger("order_id").notNullable()
      .references("id").inTable("orders").onDelete("RESTRICT");
    table.string("payment_hash", 64).notNullable().unique();
    table.timestamp("paid_at", { useTz: true }).nullable();
    table.timestamp("expires_at", { useTz: true }).notNullable();
    table.json("checkout_data").notNullable();
    table.json("swap_data").nullable();
    table.timestamps(true, true);
    table.index(["order_id", "created_at"]);
    table.index(["paid_at", "created_at"]);
  });
}

export async function down(knex) {
  await knex.schema.dropTable("openreceive_payments");
}
```

Use `trx("orders").where({ id: values.orderId }).forUpdate().first()` before
querying or inserting payment attempts.

## Settlement transaction

Find the attempt by globally unique `payment_hash`, lock its order, and set that
row's `paid_at` only when null. Record every genuinely settled attempt, even if
another attempt already paid the order. Fulfill the order only for the first
settled attempt:

```text
lock order
load payment by payment_hash
if this payment already has paid_at: return
first_for_order = no sibling payment has paid_at
set this payment.paid_at
if first_for_order: update the order or insert an outbox row
commit
```

The first-settlement action runs before commit. Do not return a boolean and
perform it afterward: a crash in that gap can suppress fulfillment on replay.
This makes repeated `onPaid` delivery harmless while preserving an accidental
second settlement for support/reconciliation. Wallet-wide reconciliation can
also observe invoices created outside this host; return without error when no
attempt matches the payment hash.
