import { paymentsDdlStatements } from "@openreceive/core";
import type { ScaffoldPaymentsOptions } from "./types.ts";

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

/**
 * The canonical `openreceive_payments` DDL — the same statements
 * `paymentsSchemaSql` in `@openreceive/http` renders — with only the
 * table names threaded through. Timestamps are unix-seconds integers. Every
 * column must be kept.
 */
export function canonicalPaymentsDdlStatements(
  options: ScaffoldPaymentsOptions,
): readonly string[] {
  return paymentsDdlStatements({
    dialect: options.dialect,
    tableName: options.tableName,
    metaTableName: options.metaTableName,
  });
}
