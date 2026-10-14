import pg from "pg";

const catalog = [
  ["Facet", "7.00", "facet"],
  ["Bezel", "12.00", "bezel"],
  ["Hinge", "4.00", "hinge"],
  ["Latch", "9.00", "latch"],
  ["Knob", "3.00", "knob"],
] as const;

let pool: pg.Pool | undefined;
let ready: Promise<pg.Pool> | undefined;

/** The shop's Postgres, from DATABASE_URL. Made on first use, so `nuxt build` never connects. */
export function usePool(): pg.Pool {
  if (pool) return pool;
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  pool.on("error", (error) => console.error("Postgres pool error:", error.message));
  return pool;
}

async function createShop(db: pg.Pool): Promise<pg.Pool> {
  await db.query(`
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
      user_id TEXT NOT NULL REFERENCES users (id),
      product_name TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  // One row at a time, so the ids follow the catalog's order.
  for (const [name, price, sku] of catalog) {
    await db.query(
      "INSERT INTO products (name, price, sku) VALUES ($1, $2, $3) ON CONFLICT (sku) DO NOTHING",
      [name, price, sku],
    );
  }
  return db;
}

/** The pool, once the shop's tables and catalog exist. Safe to call on every request. */
export function useShopDb(): Promise<pg.Pool> {
  ready ??= createShop(usePool()).catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}
