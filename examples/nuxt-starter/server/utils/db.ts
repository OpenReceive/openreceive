import pg from "pg";

let pool: pg.Pool | undefined;

/** One pool for the process, on DATABASE_URL. */
export function db(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("Add a Postgres database: set DATABASE_URL.");
  }
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return pool;
}
