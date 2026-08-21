export const OPENRECEIVE_ORMS = ["prisma", "drizzle", "typeorm", "sequelize", "knex"] as const;

export type OpenReceiveOrm = (typeof OPENRECEIVE_ORMS)[number];

export const OPENRECEIVE_DIALECTS = ["postgres", "sqlite"] as const;

export type OpenReceiveDialect = (typeof OPENRECEIVE_DIALECTS)[number];

export interface ScaffoldPaymentsOptions {
  readonly orm: OpenReceiveOrm;
  readonly dialect: OpenReceiveDialect;
  readonly tableName: string;
  readonly metaTableName: string;
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
}
