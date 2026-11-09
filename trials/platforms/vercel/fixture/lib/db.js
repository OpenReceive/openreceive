import pg from "pg";

let pool;

/** Neon's pooled URL. Vercel sets DATABASE_URL in every environment. */
export function db() {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  pool.on("error", (error) => console.error("Postgres pool error:", error.message));
  return pool;
}
