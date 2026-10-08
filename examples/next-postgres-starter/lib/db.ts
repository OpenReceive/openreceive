import { attachDatabasePool } from "@vercel/functions";
import { Pool } from "pg";

let pool: Pool | undefined;

/**
 * One pool per function instance, on Neon's pooled DATABASE_URL: a transaction
 * pooler, which OpenReceive's payment storage supports. Supabase needs its own
 * certificate authority: https://openreceive.org/guides/supabase
 */
export function db(): Pool {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Connect a Postgres database: set DATABASE_URL (Neon adds it on Vercel).");
  }
  pool = new Pool({ connectionString, max: 5 });
  // On Vercel, closes idle connections before the instance is suspended.
  attachDatabasePool(pool);
  return pool;
}
