import {
  InMemoryInvoiceKvStore,
  type OpenReceiveInvoiceKvStore
} from "@openreceive/core";
import {
  createOpenReceivePostgresKvStoreFromPool
} from "@openreceive/node";
import { Pool } from "pg";

export function createHelloFruitOpenReceiveKvStore(input: {
  readonly demoId: string;
}): OpenReceiveInvoiceKvStore {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    return new InMemoryInvoiceKvStore();
  }

  const pool = new Pool({
    connectionString: databaseUrl
  });

  return createOpenReceivePostgresKvStoreFromPool({
    pool,
    onReady(schemaVersion) {
      console.log(
        `[openreceive:${input.demoId}] Postgres KV store ready (${schemaVersion}).`
      );
    },
    onMigrationError() {
      console.error(
        `[openreceive:${input.demoId}] Postgres KV store initialization failed. Check DATABASE_URL and database reachability.`
      );
    }
  });
}
