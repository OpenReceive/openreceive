// Named SqlAdapter factories for ORM handles. `resolveSqlAdapter` recognizes
// pg and SQLite handles structurally, but an ORM's raw-query surface is too
// generic to detect safely — so these are explicit, one per ORM, and `dialect`
// stays a required argument: nothing on the handles states it reliably, and
// every statement arrives already written for it (`$n` on postgres, `?` on
// sqlite — see SqlQuery). No ORM is imported; the parameter types are
// structural views, like the pg and SQLite bindings in sql-adapters.ts.

import type { SqlAdapter, SqlQuery } from "./sql-adapters.ts";

export type SqlDialect = SqlAdapter["dialect"];

/** The raw-query slice of a Knex instance or transaction. */
export interface KnexExecutorLike {
  raw(sql: string, bindings: readonly unknown[]): Promise<unknown>;
}

/** Structural view of a Knex instance. */
export interface KnexLike extends KnexExecutorLike {
  transaction<T>(run: (trx: KnexExecutorLike) => Promise<T>): Promise<T>;
}

/**
 * Wrap a Knex instance. Knex hands the SQL and bindings to the driver
 * verbatim (`?` is already the sqlite placeholder, and `$n` postgres SQL
 * contains no `?` for Knex to rewrite); only the RESULT shape differs per
 * driver. The sqlite3 driver resolves the rows array itself; pg wraps them in
 * `{ rows }` — reaching into `result[0]` would return the first ROW on
 * sqlite, which breaks every repository read.
 */
export function knexDb(knex: KnexLike, dialect: SqlDialect): SqlAdapter {
  const queryOn =
    (executor: KnexExecutorLike): SqlQuery =>
    async (sql, params = []) => {
      const result = await executor.raw(sql, [...params]);
      return dialect === "sqlite"
        ? (result as Record<string, unknown>[])
        : ((result as { rows?: Record<string, unknown>[] }).rows ?? []);
    };
  return {
    dialect,
    query: queryOn(knex),
    transaction: (run) => knex.transaction((trx) => run({ query: queryOn(trx) })),
  };
}

/** The raw-query slice of a PrismaClient or interactive-transaction client. */
export interface PrismaExecutorLike {
  $queryRawUnsafe(sql: string, ...params: unknown[]): Promise<unknown>;
  $executeRawUnsafe(sql: string, ...params: unknown[]): Promise<unknown>;
}

/** Structural view of a PrismaClient. */
export interface PrismaLike extends PrismaExecutorLike {
  $transaction<T>(run: (tx: PrismaExecutorLike) => Promise<T>): Promise<T>;
}

/**
 * Whether a statement produces rows and must run through `$queryRawUnsafe`.
 * Same classification as the built-in SQLite binding: `SELECT`/`VALUES`/`WITH`
 * heads and any `RETURNING` clause. `RETURNING` matters beyond SELECT — the
 * settlement hook's own `UPDATE … RETURNING` claim runs through this query
 * function, and routing it to `$executeRawUnsafe` would drop its rows.
 */
function prismaStatementReturnsRows(sql: string): boolean {
  return /^\s*(?:select|values|with)\b/i.test(sql) || /\breturning\b/i.test(sql);
}

/**
 * Wrap a PrismaClient. Match `dialect` to the Prisma datasource provider.
 * Prisma splits raw SQL across two calls — `$queryRawUnsafe` resolves rows,
 * `$executeRawUnsafe` resolves an affected-row count — so statements are
 * routed by whether they return rows.
 */
export function prismaDb(prisma: PrismaLike, dialect: SqlDialect): SqlAdapter {
  const queryOn =
    (tx: PrismaExecutorLike): SqlQuery =>
    async (sql, params = []) => {
      if (prismaStatementReturnsRows(sql)) {
        return (await tx.$queryRawUnsafe(sql, ...params)) as Record<string, unknown>[];
      }
      await tx.$executeRawUnsafe(sql, ...params);
      return [];
    };
  return {
    dialect,
    query: queryOn(prisma),
    transaction: (run) => prisma.$transaction((tx) => run({ query: queryOn(tx) })),
  };
}

/** The raw-query slice of a TypeORM DataSource or transaction EntityManager. */
export interface TypeOrmExecutorLike {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Structural view of a TypeORM DataSource. */
export interface TypeOrmLike extends TypeOrmExecutorLike {
  transaction<T>(run: (manager: TypeOrmExecutorLike) => Promise<T>): Promise<T>;
}

/**
 * Wrap a TypeORM DataSource. `query` passes the SQL through verbatim and
 * already resolves rows on both drivers. The transaction callback must run
 * through the transaction's own EntityManager — falling back to the
 * DataSource would execute settlement statements outside the transaction.
 */
export function typeOrmDb(dataSource: TypeOrmLike, dialect: SqlDialect): SqlAdapter {
  const queryOn =
    (runner: TypeOrmExecutorLike): SqlQuery =>
    async (sql, params = []) =>
      ((await runner.query(sql, [...params])) ?? []) as Record<string, unknown>[];
  return {
    dialect,
    query: queryOn(dataSource),
    transaction: (run) => dataSource.transaction((manager) => run({ query: queryOn(manager) })),
  };
}

/** The raw-query slice of a Sequelize instance or a managed Transaction. */
export interface SequelizeExecutorLike {
  query(
    sql: string,
    options?: { readonly bind?: readonly unknown[]; readonly transaction?: unknown },
  ): Promise<unknown>;
}

/** Structural view of a Sequelize instance. */
export interface SequelizeLike extends SequelizeExecutorLike {
  transaction<T>(run: (transaction: unknown) => Promise<T>): Promise<T>;
}

/**
 * Wrap a Sequelize instance.
 *
 * Sequelize takes bind parameters under `bind` (not positional arguments) and
 * carries the transaction on the SAME instance via an options key rather than
 * a separate executor object — so the transaction callback threads the
 * managed transaction back into every statement. Without that, settlement
 * statements would run outside the transaction on the instance's own pool.
 *
 * `sequelize.query` resolves `[rows, metadata]` for a SELECT and metadata
 * alone for a write, so a non-array result reads as no rows.
 */
export function sequelizeDb(sequelize: SequelizeLike, dialect: SqlDialect): SqlAdapter {
  const queryOn =
    (transaction?: unknown): SqlQuery =>
    async (sql, params = []) => {
      const result = await sequelize.query(sql, {
        bind: [...params],
        ...(transaction === undefined ? {} : { transaction }),
      });
      const rows = Array.isArray(result) ? result[0] : undefined;
      return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    };
  return {
    dialect,
    query: queryOn(),
    transaction: (run) =>
      sequelize.transaction((transaction) => run({ query: queryOn(transaction) })),
  };
}
