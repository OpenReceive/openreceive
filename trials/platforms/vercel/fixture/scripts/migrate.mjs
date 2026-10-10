// Creates the shop's tables and its five products. Idempotent: it runs before
// every build on Vercel and every container start locally.
import pg from "pg";

const catalog = [
  ["Facet", "7.00", "facet"],
  ["Bezel", "12.00", "bezel"],
  ["Hinge", "4.00", "hinge"],
  ["Latch", "9.00", "latch"],
  ["Knob", "3.00", "knob"],
];

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
});
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      price TEXT NOT NULL,
      sku TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL
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
  for (const [name, price, sku] of catalog) {
    await client.query(
      "INSERT INTO products (name, price, sku) VALUES ($1, $2, $3) ON CONFLICT (sku) DO NOTHING",
      [name, price, sku],
    );
  }
} finally {
  await client.end();
}
