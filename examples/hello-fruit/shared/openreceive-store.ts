import {
  InMemoryInvoiceStore,
  type OpenReceiveInvoiceStore
} from "@openreceive/core";
import {
  createOpenReceivePostgresInvoiceStoreFromPool
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

  return createOpenReceivePostgresInvoiceStoreFromPool({
    pool,
    onReady(schemaVersion) {
      console.log(
        `[openreceive:${input.demoId}] Postgres invoice store ready (${schemaVersion}).`
      );
    },
    onMigrationError() {
      console.error(
        `[openreceive:${input.demoId}] Postgres invoice store migration failed. Check DATABASE_URL and database reachability.`
      );
    }
  });
}
