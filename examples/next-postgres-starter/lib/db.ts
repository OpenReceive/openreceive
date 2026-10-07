import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

let pool: Pool | undefined;

/**
 * One pool per function instance. Use the pooled URL: Neon's DATABASE_URL or
 * Supabase's POSTGRES_URL. Both go through a transaction pooler, which
 * OpenReceive's payment storage supports.
 */
export function db(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!connectionString) {
    throw new Error(
      "Connect a Postgres database: set DATABASE_URL (Neon) or POSTGRES_URL (Supabase).",
    );
  }
  pool = new Pool({ connectionString, max: 5 });
  // On Vercel, closes idle connections before the instance is suspended.
  attachDatabasePool(pool);
  return pool;
}
