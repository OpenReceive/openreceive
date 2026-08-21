import type { OpenReceiveDialect, OrderIdType, ScaffoldPaymentsOptions } from "./types.ts";

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

export function isSqlite(options: ScaffoldPaymentsOptions): boolean {
  return options.dialect === "sqlite";
}

/** Raw SQL type for order_id, matching --order-id-type on the chosen dialect. */
export function sqlOrderIdType(orderIdType: OrderIdType, dialect: OpenReceiveDialect): string {
  if (dialect === "sqlite") {
    switch (orderIdType) {
      case "bigint":
      case "integer":
        return "INTEGER";
      case "uuid":
      case "string":
        return "TEXT";
    }
  }
  switch (orderIdType) {
    case "bigint":
      return "BIGINT";
    case "integer":
      return "INTEGER";
    case "uuid":
      return "UUID";
    case "string":
      return "TEXT";
  }
}

/**
 * The canonical `openreceive_payments` DDL owned by the library
 * (`openReceivePaymentsSchemaSql` in `@openreceive/http`), with `order_id`
 * typed to match --order-id-type and an optional foreign key to the host order
 * table. Timestamps are unix-seconds integers. Every column must be kept.
 */
export function canonicalPaymentsDdlStatements(
  options: ScaffoldPaymentsOptions,
): readonly string[] {
  const primaryKey =
    options.dialect === "postgres"
      ? "id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY"
      : "id INTEGER PRIMARY KEY AUTOINCREMENT";
  const bigint = options.dialect === "postgres" ? "BIGINT" : "INTEGER";
  const foreignKey = options.skipForeignKey ? "" : ` REFERENCES ${options.orderTable} (id)`;
  const paymentHashCheck =
    options.dialect === "postgres"
      ? "payment_hash ~ '^[0-9a-f]{64}$'"
      : "length(payment_hash) = 64 AND payment_hash NOT GLOB '*[^0-9a-f]*'";
  return [
    [
      "CREATE TABLE IF NOT EXISTS openreceive_payments (",
      `  ${primaryKey},`,
      `  order_id ${sqlOrderIdType(options.orderIdType, options.dialect)} NOT NULL${foreignKey},`,
      "  payment_hash TEXT NOT NULL UNIQUE,",
      "  status TEXT NOT NULL DEFAULT 'pending',",
      "  status_reason TEXT,",
      `  paid_at ${bigint},`,
      `  expires_at ${bigint} NOT NULL,`,
      `  created_at ${bigint} NOT NULL,`,
      `  updated_at ${bigint} NOT NULL,`,
      `  inserted_at ${bigint} NOT NULL,`,
      "  checkout_data TEXT NOT NULL,",
      "  swap_data TEXT,",
      "  client_ip TEXT,",
      "  CHECK (status IN ('pending', 'settled', 'expired', 'failed', 'attention')),",
      `  CHECK (${paymentHashCheck})`,
      ")",
    ].join("\n"),
    "CREATE INDEX IF NOT EXISTS openreceive_payments_order_created_idx ON openreceive_payments (order_id, created_at)",
    "CREATE INDEX IF NOT EXISTS openreceive_payments_status_created_idx ON openreceive_payments (status, created_at)",
    "CREATE INDEX IF NOT EXISTS openreceive_payments_client_ip_inserted_idx ON openreceive_payments (client_ip, inserted_at)",
    // The sibling key/value/rev table backing the durable reconcile gate every
    // worker on this database shares. Same host database, never a second one.
    // Its schema_version row records the generation the library installed.
    [
      "CREATE TABLE IF NOT EXISTS openreceive_meta (",
      "  key TEXT PRIMARY KEY,",
      "  value TEXT NOT NULL,",
      `  rev ${bigint} NOT NULL DEFAULT 0`,
      ")",
    ].join("\n"),
    options.dialect === "postgres"
      ? "INSERT INTO openreceive_meta (key, value, rev) VALUES ('schema_version', '1', 0) ON CONFLICT (key) DO NOTHING"
      : "INSERT OR IGNORE INTO openreceive_meta (key, value, rev) VALUES ('schema_version', '1', 0)",
  ];
}

export function prismaOrderIdField(
  orderIdType: OrderIdType,
  dialect: ScaffoldPaymentsOptions["dialect"],
): string {
  switch (orderIdType) {
    case "bigint":
      return `BigInt  @map("order_id")`;
    case "integer":
      return `Int     @map("order_id")`;
    case "uuid":
      return dialect === "sqlite"
        ? `String  @map("order_id")`
        : `String  @map("order_id") @db.Uuid`;
    case "string":
      return `String  @map("order_id")`;
  }
}

export function drizzleOrderIdColumn(
  orderIdType: OrderIdType,
  dialect: ScaffoldPaymentsOptions["dialect"],
): string {
  if (dialect === "sqlite") {
    switch (orderIdType) {
      case "bigint":
      case "integer":
        return `integer("order_id").notNull()`;
      case "uuid":
      case "string":
        return `text("order_id").notNull()`;
    }
  }
  switch (orderIdType) {
    case "bigint":
      return `bigint("order_id", { mode: "number" }).notNull()`;
    case "integer":
      return `integer("order_id").notNull()`;
    case "uuid":
      return `uuid("order_id").notNull()`;
    case "string":
      return `text("order_id").notNull()`;
  }
}

export function sequelizeOrderIdType(orderIdType: OrderIdType): string {
  switch (orderIdType) {
    case "bigint":
      return "Sequelize.BIGINT";
    case "integer":
      return "Sequelize.INTEGER";
    case "uuid":
      return "Sequelize.UUID";
    case "string":
      return "Sequelize.TEXT";
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
      return `table.text("order_id").notNullable()`;
  }
}
