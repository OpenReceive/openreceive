import type { OrderIdType, ScaffoldPaymentsOptions } from "./types.ts";

export function defaultOrderTable(orderModel: string): string {
  const snake = orderModel
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
  if (snake.endsWith("s")) return snake;
  if (snake.endsWith("y") && !/[aeiou]y$/i.test(snake)) {
    return `${snake.slice(0, -1)}ies`;
  }
  return `${snake}s`;
}

export function assertOrderModelName(value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Z][A-Za-z0-9]*$/.test(trimmed)) {
    throw new Error(
      "Order model must be a PascalCase TypeScript/class name (for example Order or Purchase).",
    );
  }
  return trimmed;
}

export function assertOrderTableName(value: string): string {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
    throw new Error(
      "Order table must be a lowercase SQL identifier (for example orders or purchases).",
    );
  }
  return trimmed;
}

export function prismaOrderIdField(orderIdType: OrderIdType): string {
  switch (orderIdType) {
    case "bigint":
      return `BigInt  @map("order_id")`;
    case "integer":
      return `Int     @map("order_id")`;
    case "uuid":
      return `String  @map("order_id") @db.Uuid`;
    case "string":
      return `String  @map("order_id")`;
  }
}

export function drizzleOrderIdColumn(orderIdType: OrderIdType): string {
  switch (orderIdType) {
    case "bigint":
      return `bigint("order_id", { mode: "number" }).notNull()`;
    case "integer":
      return `integer("order_id").notNull()`;
    case "uuid":
      return `uuid("order_id").notNull()`;
    case "string":
      return `varchar("order_id", { length: 191 }).notNull()`;
  }
}

export function typeOrmOrderIdColumn(orderIdType: OrderIdType): string {
  switch (orderIdType) {
    case "bigint":
      return `{ name: "order_id", type: "bigint" }`;
    case "integer":
      return `{ name: "order_id", type: "int" }`;
    case "uuid":
      return `{ name: "order_id", type: "uuid" }`;
    case "string":
      return `{ name: "order_id", type: "varchar", length: 191 }`;
  }
}

export function sequelizeOrderIdType(orderIdType: OrderIdType): string {
  switch (orderIdType) {
    case "bigint":
      return `DataTypes.BIGINT`;
    case "integer":
      return `DataTypes.INTEGER`;
    case "uuid":
      return `DataTypes.UUID`;
    case "string":
      return `DataTypes.STRING(191)`;
  }
}

export function knexOrderIdColumn(orderIdType: OrderIdType): string {
  switch (orderIdType) {
    case "bigint":
      return `table.bigInteger("order_id").notNullable()`;
    case "integer":
      return `table.integer("order_id").notNullable()`;
    case "uuid":
      return `table.uuid("order_id").notNullable()`;
    case "string":
      return `table.string("order_id", 191).notNullable()`;
  }
}

export function tsOrderIdType(orderIdType: OrderIdType): string {
  switch (orderIdType) {
    case "bigint":
    case "integer":
      return "number";
    case "uuid":
    case "string":
      return "string";
  }
}

export function nextStepsMarkdown(options: ScaffoldPaymentsOptions): string {
  const migrate =
    options.orm === "prisma"
      ? "Merge `prisma/schema.openreceive.prisma` into your Prisma schema, then run `npx prisma migrate dev`."
      : options.orm === "drizzle"
        ? "Export `openReceivePayments` from your Drizzle schema entrypoint, then run your usual `drizzle-kit generate` / migrate."
        : options.orm === "typeorm"
          ? "Register `OpenReceivePayment` with your TypeORM `entities` list and run your usual migration generate/run."
          : options.orm === "sequelize"
            ? "Call `initOpenReceivePayment(sequelize)` during Sequelize boot, then sync or run a migration for `openreceive_payments`."
            : "Copy the Knex migration into your migrations folder (or keep the generated path) and run `npx knex migrate:latest`.";

  return `# OpenReceive payment attempts

Host-owned scaffolding for \`${options.orm}\`.

## Next steps

1. ${migrate}
2. Fill in \`loadOrder\` and \`amountForOrder\` in \`src/openreceive/hooks.stub.ts\`.
3. Pass the returned hooks to your mounted adapter (\`resolveCheckout\` / \`onCheckoutCreated\`).
4. On settlement, call \`markOpenReceivePaidOnce\` and fulfill only when \`firstForOrder\` is true.
5. Never return \`swap_data\` / \`swapData\` from application APIs, logs, or browser bundles.

OpenReceive does not open a database connection and does not run migrations for you.
`;
}
