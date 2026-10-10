import pg from "pg";

let pool;

/** Neon's pooled URL. Vercel sets DATABASE_URL in every environment. */
export function db() {
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return pool;
}
