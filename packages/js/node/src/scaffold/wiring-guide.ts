import { openReceivePaymentsColumnNames, openReceivePaymentsSeedSql } from "@openreceive/core";
import { isSqlite } from "./shared.ts";
import type { ScaffoldPaymentsOptions } from "./types.ts";

const PLACEHOLDER_NOTE =
  "Custom adapters receive SQL already written for their own dialect (`?` on sqlite, " +
  "`$1`-style on postgres) — pass it to the driver verbatim — and must return SELECT rows " +
  "as plain objects.";

/**
 * OPENRECEIVE_PAYMENTS.md: run the ORM migration, then wire
 * `createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid })`. The
 * scaffold emits no repository code — the library owns it at runtime.
 */
export function wiringGuideMarkdown(options: ScaffoldPaymentsOptions): string {
  const columnList = openReceivePaymentsColumnNames()
    .map((name) => `\`${name}\``)
    .join(", ");
  return `# OpenReceive payments wiring

Generated for **${options.orm}** (${options.dialect}). This scaffold emits only the
\`${options.tableName}\` + \`${options.metaTableName}\` schema/migration and this guide.
The OpenReceive library owns the payment-attempt repository at runtime — commit
locking, settlement write-once, the durable reconcile gate, and reconciliation
state transitions all run inside \`@openreceive/http\`, never in generated or
hand-written host code.

## 1. Run the migration

${migrationStep(options)}

Keep every column: ${columnList}. The timestamp columns (\`paid_at\`,
\`expires_at\`, \`created_at\`, \`updated_at\`, \`inserted_at\`) are
unix-seconds integers, never datetime columns. \`inserted_at\` is stamped from the host's
local clock and is what the per-IP rate limiter counts on
(\`countAttemptsFromIp\`): dropping it silently disables DB-backed rate
limiting. Keep the sibling \`${options.metaTableName}\` table (\`key\`, \`value\`,
\`rev\`) too: it is the durable reconcile gate every worker on this database
shares.

## 2. Wire the host integration

\`\`\`ts
import { createOpenReceiveHost } from "@openreceive/http";

const host = createOpenReceiveHost({ db, loadOrder, amountForOrder, onPaid });
\`\`\`

- \`loadOrder(orderId)\` returns your order, or \`null\` for a 404.
- \`amountForOrder(order)\` returns the trusted host amount, never a payer-supplied value.
- \`onPaid\` fires for the order's first settled attempt only. Mark the order
  paid with your own ORM:

\`\`\`ts
const onPaid = async ({ orderId }) => {
  ${onPaidUpdateLine(options)}
};
\`\`\`

  \`onPaid\` also receives \`{ paymentHash, paidAt, query }\`. \`query\` runs
  inside the settlement transaction — use it for transactional outbox rows or to
  make the order update atomic with the payment record. Plain ORM calls are
  fine: delivery is at-least-once and retried until \`onPaid\` succeeds, so make
  it idempotent.

Pass the same \`host\` to your mounted HTTP adapter. No background process is
needed: every mounted OpenReceive route runs an opportunistic, durably gated
reconcile pass by default (\`opportunisticReconcile\`), so abandoned checkouts
settle on any later OpenReceive call — serverless included.

Optionally, for push settlement the moment the wallet reports
\`payment_received\`, run the notifications worker as its own long-lived
process; it listens for NWC-02 notifications AND reconciles periodically (the
safety net for notifications missed while it was down):

\`\`\`ts
// worker.ts — run with: node worker.ts (e.g. a package.json "worker" script)
import { startOpenReceiveNotificationWorker } from "@openreceive/http";

const worker = await startOpenReceiveNotificationWorker({ service, host });
process.once("SIGINT", () => void worker.stop());
process.once("SIGTERM", () => void worker.stop());
\`\`\`

## 3. What to pass as \`db\`

${dbSection(options)}

Never expose \`swap_data\` / \`swapData\` from application APIs, logs, or browser bundles.
`;
}

function onPaidUpdateLine(options: ScaffoldPaymentsOptions): string {
  switch (options.orm) {
    case "prisma":
      return 'await prisma.order.update({ where: { id: orderId }, data: { state: "paid" } });';
    case "drizzle":
      return 'await orm.update(orders).set({ state: "paid" }).where(eq(orders.id, orderId));';
    case "typeorm":
      return 'await dataSource.getRepository(Order).update({ id: orderId }, { state: "paid" });';
    case "sequelize":
      return 'await Order.update({ state: "paid" }, { where: { id: orderId } });';
    case "knex":
      return 'await knex("orders").where({ id: orderId }).update({ state: "paid" });';
  }
}

function migrationStep(options: ScaffoldPaymentsOptions): string {
  switch (options.orm) {
    case "prisma":
      return `Merge \`prisma/schema.openreceive.prisma\` (both models) into your Prisma schema,
then run \`npx prisma migrate dev --create-only --name create_openreceive_tables\`.
Prisma's schema language cannot express the canonical CHECK constraints or the
\`schema_version\` seed row, so before applying the draft migration, add the
statements from \`prisma/openreceive-constraints.sql\` to it (the file says
how), then run \`npx prisma migrate dev\`.`;
    case "drizzle":
      return `Export \`openReceivePayments\` and \`openReceiveMeta\` from
\`src/db/openreceive-tables.ts\` in your Drizzle schema entrypoint, then run
\`drizzle-kit generate\` and your usual migrate step. The schema carries both
canonical CHECK constraints; the \`schema_version\` seed row cannot be expressed
in schema, so also create a custom migration for it —
\`drizzle-kit generate --custom --name openreceive-seed\` — containing:

\`\`\`sql
${openReceivePaymentsSeedSql(options.dialect, options.metaTableName)};
\`\`\``;
    case "typeorm":
      return "Register `src/migrations/20260101000000-create-openreceive-tables.ts` in your DataSource `migrations` list, then run migrations through your usual workflow (for example `npx typeorm migration:run`). The migration executes the canonical OpenReceive DDL directly; no entity class is needed.";
    case "sequelize":
      return "Keep `migrations/20260101000000-create-openreceive-tables.cjs` in your sequelize-cli migrations folder, then run `npx sequelize-cli db:migrate`. The migration executes the canonical OpenReceive DDL directly; no model class is needed.";
    case "knex":
      return "Keep `db/migrations/20260101000000_create_openreceive_tables.mjs` in your Knex migrations directory, then run `npx knex migrate:latest`. The migration executes the canonical OpenReceive DDL directly.";
  }
}

function dbSection(options: ScaffoldPaymentsOptions): string {
  switch (options.orm) {
    case "prisma":
      return prismaDbSection(options);
    case "drizzle":
      return drizzleDbSection(options);
    case "typeorm":
      return typeOrmDbSection(options);
    case "sequelize":
      return sequelizeDbSection(options);
    case "knex":
      return knexDbSection(options);
  }
}

function prismaDbSection(options: ScaffoldPaymentsOptions): string {
  return `Prisma keeps its connection pool private, so pass a small custom
\`OpenReceiveSqlAdapter\` built from \`$transaction\` + \`$queryRawUnsafe\`. Set
\`dialect\` to match your Prisma datasource provider. ${PLACEHOLDER_NOTE}

\`\`\`ts
import { PrismaClient } from "@prisma/client";
import type { OpenReceiveSqlAdapter, OpenReceiveSqlQuery } from "@openreceive/http";

const prisma = new PrismaClient();
const queryOn =
  (client: {
    $queryRawUnsafe(sql: string, ...params: unknown[]): Promise<unknown>;
  }): OpenReceiveSqlQuery =>
  async (sql, params = []) =>
    (await client.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[];

export const db: OpenReceiveSqlAdapter = {
  dialect: "${options.dialect}", // match your Prisma datasource provider
  query: queryOn(prisma),
  transaction: (run) => prisma.$transaction((tx) => run({ query: queryOn(tx) })),
};
\`\`\``;
}

function knexDbSection(options: ScaffoldPaymentsOptions): string {
  const rows = isSqlite(options)
    ? `    // Knex sqlite3 returns SELECT rows directly.
    return (await executor.raw(sql, [...params])) as Record<string, unknown>[];`
    : `    const result = await executor.raw(sql, [...params]);
    return (result as { rows: Record<string, unknown>[] }).rows ?? [];`;
  return `Wrap your Knex instance in a small custom adapter built from
\`knex.transaction\` + \`knex.raw\`. ${PLACEHOLDER_NOTE}

\`\`\`ts
import type { Knex } from "knex";
import type { OpenReceiveSqlAdapter, OpenReceiveSqlQuery } from "@openreceive/http";
import { knex } from "./db.ts"; // your configured Knex instance

const queryOn =
  (executor: Knex | Knex.Transaction): OpenReceiveSqlQuery =>
  async (sql, params = []) => {
${rows}
  };

export const db: OpenReceiveSqlAdapter = {
  dialect: "${options.dialect}",
  query: queryOn(knex),
  transaction: (run) => knex.transaction((trx) => run({ query: queryOn(trx) })),
};
\`\`\``;
}

function typeOrmDbSection(options: ScaffoldPaymentsOptions): string {
  return `Wrap your initialized DataSource in a small custom adapter built from
\`dataSource.transaction\` + \`manager.query\`. ${PLACEHOLDER_NOTE}

\`\`\`ts
import type { OpenReceiveSqlAdapter, OpenReceiveSqlQuery } from "@openreceive/http";
import { dataSource } from "./data-source.ts"; // your initialized DataSource
const queryOn =
  (runner: { query(sql: string, params?: unknown[]): Promise<unknown> }): OpenReceiveSqlQuery =>
  async (sql, params = []) =>
    ((await runner.query(sql, [...params])) ?? []) as Record<string, unknown>[];

export const db: OpenReceiveSqlAdapter = {
  dialect: "${options.dialect}",
  query: queryOn(dataSource),
  transaction: (run) => dataSource.transaction((manager) => run({ query: queryOn(manager) })),
};
\`\`\``;
}

function drizzleDbSection(options: ScaffoldPaymentsOptions): string {
  const snippet = isSqlite(options)
    ? `\`\`\`ts
import Database from "better-sqlite3"; // or DatabaseSync from "node:sqlite"
import { drizzle } from "drizzle-orm/better-sqlite3"; // node:sqlite users: drizzle-orm/node-sqlite

const sqlite = new Database("app.db");
const orm = drizzle(sqlite);
const host = createOpenReceiveHost({ db: sqlite, loadOrder, amountForOrder, onPaid });
\`\`\``
    : `\`\`\`ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const orm = drizzle(pool);
const host = createOpenReceiveHost({ db: pool, loadOrder, amountForOrder, onPaid });
\`\`\``;
  const handle = isSqlite(options)
    ? "the better-sqlite3 / `node:sqlite` Database"
    : "the `pg` Pool";
  return `Pass the underlying driver handle you already give \`drizzle(...)\` —
${handle} — straight through as \`db\`. The library binds to the driver, so no
adapter is needed.

${snippet}`;
}

function sequelizeDbSection(options: ScaffoldPaymentsOptions): string {
  const snippet = isSqlite(options)
    ? `\`\`\`ts
import { DatabaseSync } from "node:sqlite"; // or better-sqlite3

export const db = new DatabaseSync("app.db"); // same file Sequelize uses
\`\`\``
    : `\`\`\`ts
import { Pool } from "pg";

export const db = new Pool({ connectionString: process.env.DATABASE_URL });
\`\`\``;
  const handle = isSqlite(options)
    ? "sqlite users open the same database file with better-sqlite3 or `node:sqlite` and pass that Database"
    : "pg users pass a `pg` Pool pointed at the same database";
  return `Sequelize does not expose a raw handle the library can bind to, so open
one extra handle to the same database and pass it as \`db\`: ${handle}.

${snippet}`;
}
