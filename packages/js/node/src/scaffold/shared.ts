import { openReceivePaymentsDdlStatements } from "@openreceive/core";
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

export function assertPaymentsTableName(value: string, flag: string): string {
  const trimmed = value.trim();
  if (!/^[a-z][a-z0-9_]*$/.test(trimmed)) {
    throw new Error(`${flag} must be a lowercase SQL identifier.`);
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
 * The canonical `openreceive_payments` DDL — the same statements
 * `openReceivePaymentsSchemaSql` in `@openreceive/http` renders — with
 * `order_id` typed to match --order-id-type, an optional foreign key to the
 * host order table, and the table names threaded through. Timestamps are
 * unix-seconds integers. Every column must be kept.
 */
export function canonicalPaymentsDdlStatements(
  options: ScaffoldPaymentsOptions,
): readonly string[] {
  return openReceivePaymentsDdlStatements({
    dialect: options.dialect,
    tableName: options.tableName,
    metaTableName: options.metaTableName,
    orderIdSqlType: sqlOrderIdType(options.orderIdType, options.dialect),
    orderIdReferencesSql: options.skipForeignKey ? "" : ` REFERENCES ${options.orderTable} (id)`,
  });
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
