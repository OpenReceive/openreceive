export const OPENRECEIVE_ORMS = ["prisma", "drizzle", "typeorm", "sequelize", "knex"] as const;

export type Orm = (typeof OPENRECEIVE_ORMS)[number];

export const OPENRECEIVE_DIALECTS = ["postgres", "sqlite"] as const;

export type Dialect = (typeof OPENRECEIVE_DIALECTS)[number];

export interface ScaffoldPaymentsOptions {
  readonly orm: Orm;
  readonly dialect: Dialect;
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
