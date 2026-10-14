import pg from "pg";

let pool: pg.Pool | undefined;

// One pool for the server process, made on the first query rather than at
// import, so `react-router build` never needs the database.
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}
