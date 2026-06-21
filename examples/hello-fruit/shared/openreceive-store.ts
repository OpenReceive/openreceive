import {
  InMemoryInvoiceStore,
  type OpenReceiveInvoiceStore
} from "@openreceive/core";
import {
  OPENRECEIVE_DATABASE_SCHEMA_VERSION,
  OPENRECEIVE_POSTGRES_MIGRATION_SQL,
  createOpenReceivePostgresInvoiceStore,
  type OpenReceivePostgresQueryClient
} from "@openreceive/node";
import { Pool } from "pg";

export function createHelloFruitOpenReceiveInvoiceStore(input: {
  readonly demoId: string;
}): OpenReceiveInvoiceStore {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    return new InMemoryInvoiceStore();
  }

  const pool = new Pool({
    connectionString: databaseUrl
  });
  const migration = pool.query(OPENRECEIVE_POSTGRES_MIGRATION_SQL)
    .then(() => {
      console.log(
        `[openreceive:${input.demoId}] Postgres invoice store ready (${OPENRECEIVE_DATABASE_SCHEMA_VERSION}).`
      );
    });

  void migration.catch(() => {
    console.error(
      `[openreceive:${input.demoId}] Postgres invoice store migration failed. Check DATABASE_URL and database reachability.`
    );
  });

  const client: OpenReceivePostgresQueryClient = {
    async query(sql, values) {
      await migration;
      const result = await pool.query(
        sql,
        values === undefined ? undefined : [...values]
      );
      return {
        rows: result.rows as Record<string, unknown>[]
      };
    }
  };

  return createOpenReceivePostgresInvoiceStore({
    client
  });
}
