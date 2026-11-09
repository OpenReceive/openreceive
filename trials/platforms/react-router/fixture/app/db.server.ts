import pg from "pg";

let pool: pg.Pool | undefined;

// One pool for the server process, made on the first query rather than at
// import, so `react-router build` never needs the database.
export function db(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (error) => console.error("Postgres pool error:", error.message));
  return pool;
}
