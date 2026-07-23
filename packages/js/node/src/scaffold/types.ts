export const OPENRECEIVE_ORMS = [
  "prisma",
  "drizzle",
  "typeorm",
  "sequelize",
  "knex",
] as const;

export type OpenReceiveOrm = (typeof OPENRECEIVE_ORMS)[number];

export const ORDER_ID_TYPES = ["bigint", "integer", "uuid", "string"] as const;

export type OrderIdType = (typeof ORDER_ID_TYPES)[number];

export interface ScaffoldPaymentsOptions {
  readonly orm: OpenReceiveOrm;
  readonly orderModel: string;
  readonly orderTable: string;
  readonly orderIdType: OrderIdType;
  readonly skipForeignKey: boolean;
  readonly outDir: string;
  readonly force: boolean;
}

export interface ScaffoldFile {
  readonly path: string;
  readonly contents: string;
}

export interface ScaffoldResult {
  readonly files: readonly ScaffoldFile[];
  readonly written: readonly string[];
  readonly skipped: readonly string[];
}
