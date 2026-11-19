// Creates the shop's tables and its five products. Idempotent: Vercel runs it
// in every build ("build" in package.json), and so does `docker compose up`.
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
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      guest_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  for (const [name, price, sku] of catalog) {
    await client.query(
      "INSERT INTO products (name, price, sku) VALUES ($1, $2, $3) ON CONFLICT (sku) DO NOTHING",
      [name, price, sku],
    );
  }
  console.log("Database tables are ready.");
} finally {
  await client.end();
}
