// Server only: import this from pages and endpoints that render on demand.
import { DATABASE_URL } from "astro:env/server";
import pg from "pg";

let pool: pg.Pool | undefined;
let setUp: Promise<void> | undefined;

/** The shop's Postgres pool, made on first use, so `astro build` never connects. */
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: DATABASE_URL });
  return pool;
}

const catalog = [
  ["Facet", "7.00", "facet"],
  ["Bezel", "12.00", "bezel"],
  ["Hinge", "4.00", "hinge"],
  ["Latch", "9.00", "latch"],
  ["Knob", "3.00", "knob"],
];

/** Creates the shop's tables if they are missing and seeds the catalog, once per process. */
export function ready(): Promise<void> {
  setUp ??= createTables().catch((error: unknown) => {
    setUp = undefined;
    throw error;
  });
  return setUp;
}

async function createTables(): Promise<void> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  const rows = catalog.map((_, index) => `($${index * 3 + 1}, $${index * 3 + 2}, $${index * 3 + 3})`);
  await db().query(
    `INSERT INTO products (name, price, sku) VALUES ${rows.join(", ")} ON CONFLICT (sku) DO NOTHING`,
    catalog.flat(),
  );
}
