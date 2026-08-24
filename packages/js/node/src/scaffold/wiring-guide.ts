import { fulfillmentNoteMarkdown, paymentsColumnNames, paymentsSeedSql } from "@openreceive/core";
import { isSqlite } from "./shared.ts";
import type { ScaffoldPaymentsOptions } from "./types.ts";

const PLACEHOLDER_NOTE =
  "Custom adapters receive SQL already written for their own dialect (`?` on sqlite, " +
  "`$1`-style on postgres) — pass it to the driver verbatim — and must return SELECT rows " +
  "as plain objects.";

/**
 * OPENRECEIVE_PAYMENTS.md: run the ORM migration, then wire
 * `createHost({ db, amountFor, onPaid })`. The scaffold emits no repository
 * code — the library owns it at runtime.
 */
export function wiringGuideMarkdown(options: ScaffoldPaymentsOptions): string {
  const columnList = paymentsColumnNames()
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
import { createHost } from "@openreceive/http";

const host = createHost({ db, amountFor, onPaid });
\`\`\`

- \`amountFor(reference)\` returns the trusted amount — never a payer-supplied
  value — or \`null\` for a 404.
- \`onPaid\` fires for the first settled attempt for a reference only, so give
  every order its own reference and never reuse one. Mark the order paid with
  your own ORM:

\`\`\`ts
const onPaid = async ({ reference }) => {
  ${onPaidUpdateLine(options)}
};
\`\`\`

  \`onPaid\` also receives \`{ paymentHash, paidAt, query }\`. \`query\` runs
  inside the settlement transaction — use it for transactional outbox rows or to
  make the order update atomic with the payment record. Plain ORM calls are
  fine: delivery is at-least-once and retried until \`onPaid\` succeeds, so make
  it idempotent.

The one-liner above is deliberately the simplest thing that works — see
[section 3](#3-fulfilling-exactly-once) before shipping it.

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
import { startNotificationWorker } from "@openreceive/http";

const worker = await startNotificationWorker({ service, host });
process.once("SIGINT", () => void worker.stop());
process.once("SIGTERM", () => void worker.stop());
\`\`\`

## 3. Fulfilling exactly once

${fulfillmentNoteMarkdown(options.tableName)}

In this project's terms, the guarded write goes inside \`onPaid\`:

\`\`\`ts
const onPaid = async ({ reference, paidAt, query }) => {
  // \`query\` runs in OpenReceive's settlement transaction, so the order
  // transition and the payment record commit or roll back together.
  const claimed = await query(
    ${guardedUpdateSql(options)},
    [paidAt, reference],
  );
  if (claimed.length === 0) return; // someone else already fulfilled it
  await shipOrder(reference);
};
\`\`\`

## 4. What to pass as \`db\`

${dbSection(options)}

Never expose \`swap_data\` / \`swapData\` from application APIs, logs, or browser bundles.
`;
}

/**
 * The guarded, idempotent order transition, written for this scaffold's
 * dialect. Postgres and modern SQLite both support RETURNING, so the host can
 * tell "I won the claim" from "someone already had it" by row count alone
 * rather than by a driver-specific affected-rows field.
 */
function guardedUpdateSql(options: ScaffoldPaymentsOptions): string {
  const [paidAt, reference] = isSqlite(options) ? ["?", "?"] : ["$1", "$2"];
  // Indented to sit under the 4-space `query(` argument in the rendered
  // snippet, with the SQL keywords right-aligned into one river.
  return [
    "`UPDATE orders",
    `        SET state = 'paid', paid_at = ${paidAt}`,
    `      WHERE id = ${reference}`,
    "        AND state = 'awaiting_payment'",
    "     RETURNING id`",
  ].join("\n");
}

function onPaidUpdateLine(options: ScaffoldPaymentsOptions): string {
  switch (options.orm) {
    case "prisma":
      return 'await prisma.order.update({ where: { id: reference }, data: { state: "paid" } });';
    case "drizzle":
      return 'await orm.update(orders).set({ state: "paid" }).where(eq(orders.id, reference));';
    case "typeorm":
      return 'await dataSource.getRepository(Order).update({ id: reference }, { state: "paid" });';
    case "sequelize":
      return 'await Order.update({ state: "paid" }, { where: { id: reference } });';
    case "knex":
      return 'await knex("orders").where({ id: reference }).update({ state: "paid" });';
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
      return `Export \`payments\` and \`meta\` from
\`src/db/openreceive-tables.ts\` in your Drizzle schema entrypoint, then run
\`drizzle-kit generate\` and your usual migrate step. The schema carries both
canonical CHECK constraints; the \`schema_version\` seed row cannot be expressed
in schema, so also create a custom migration for it —
\`drizzle-kit generate --custom --name openreceive-seed\` — containing:

\`\`\`sql
${paymentsSeedSql(options.dialect, options.metaTableName)};
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
  return `Prisma keeps its connection pool private, so it needs an adapter —
\`prismaDb\` is the shipped one. It routes each statement to
\`$queryRawUnsafe\` or \`$executeRawUnsafe\` by whether it returns rows;
hand-rolling that router is where custom Prisma adapters go wrong. Set the
dialect to match your Prisma datasource provider. ${PLACEHOLDER_NOTE}

\`\`\`ts
import { PrismaClient } from "@prisma/client";
import { prismaDb } from "@openreceive/http";

const prisma = new PrismaClient();
export const db = prismaDb(prisma, "${options.dialect}");
\`\`\``;
}

function knexDbSection(options: ScaffoldPaymentsOptions): string {
  return `Knex needs an adapter — \`knexDb\` is the shipped one, and it
already handles the sqlite-versus-postgres difference in what \`raw\`
returns. ${PLACEHOLDER_NOTE}

\`\`\`ts
import { knexDb } from "@openreceive/http";
import { knex } from "./db.ts"; // your configured Knex instance

export const db = knexDb(knex, "${options.dialect}");
\`\`\``;
}

function typeOrmDbSection(options: ScaffoldPaymentsOptions): string {
  return `TypeORM needs an adapter — \`typeOrmDb\` is the shipped one, built
on \`dataSource.transaction\` + \`manager.query\`. ${PLACEHOLDER_NOTE}

\`\`\`ts
import { typeOrmDb } from "@openreceive/http";
import { dataSource } from "./data-source.ts"; // your initialized DataSource

export const db = typeOrmDb(dataSource, "${options.dialect}");
\`\`\``;
}

function drizzleDbSection(options: ScaffoldPaymentsOptions): string {
  const snippet = isSqlite(options)
    ? `\`\`\`ts
import Database from "better-sqlite3"; // or DatabaseSync from "node:sqlite"
import { drizzle } from "drizzle-orm/better-sqlite3"; // node:sqlite users: drizzle-orm/node-sqlite

const sqlite = new Database("app.db");
const orm = drizzle(sqlite);
const host = createHost({ db: sqlite, amountFor, onPaid });
\`\`\``
    : `\`\`\`ts
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const orm = drizzle(pool);
const host = createHost({ db: pool, amountFor, onPaid });
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
  return `Sequelize needs an adapter — \`sequelizeDb\` is the shipped one. It
binds parameters through Sequelize's \`bind\` option and threads the managed
transaction into every statement inside it, so settlement never runs outside
the transaction. ${PLACEHOLDER_NOTE}

\`\`\`ts
import { sequelizeDb } from "@openreceive/http";
import { sequelize } from "./db.ts"; // your configured Sequelize instance

export const db = sequelizeDb(sequelize, "${options.dialect}");
\`\`\``;
}
