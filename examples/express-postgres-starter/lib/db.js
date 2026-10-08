import pg from "pg";

let pool;

/**
 * One pool for the process. Replit sets DATABASE_URL: the development
 * database in the editor, and the production database in a published app.
 * The URL decides TLS: Replit's production URL asks for it, the development
 * one does not.
 */
export function db() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("Add a Postgres database: set DATABASE_URL.");
  }
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return pool;
}
