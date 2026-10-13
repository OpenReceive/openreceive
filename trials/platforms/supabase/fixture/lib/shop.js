import { pool } from "./db.js";

const catalog = [
  ["Facet", "7.00", "facet"],
  ["Bezel", "12.00", "bezel"],
  ["Hinge", "4.00", "hinge"],
  ["Latch", "9.00", "latch"],
  ["Knob", "3.00", "knob"],
];

/** Creates the shop's tables and its five products. Runs at every start. */
export async function setupDatabase() {
  await pool.query(`
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
  for (const [name, price, sku] of catalog) {
    await pool.query(
      "INSERT INTO products (name, price, sku) VALUES ($1, $2, $3) ON CONFLICT (sku) DO NOTHING",
      [name, price, sku],
    );
  }
}

export async function listProducts() {
  const { rows } = await pool.query("SELECT id, name, price FROM products ORDER BY id");
  return rows;
}

export async function findProduct(id) {
  const { rows } = await pool.query("SELECT name, price FROM products WHERE id = $1", [id]);
  return rows[0];
}

export async function findUser(id) {
  const { rows } = await pool.query("SELECT id FROM users WHERE id = $1", [id]);
  return rows[0];
}

export async function createUser(id) {
  await pool.query("INSERT INTO users (id) VALUES ($1)", [id]);
}

export async function createOrder(userId, product) {
  const { rows } = await pool.query(
    "INSERT INTO orders (user_id, product_name, amount, currency, status) VALUES ($1, $2, $3, 'USD', 'awaiting_payment') RETURNING id",
    [userId, product.name, product.price],
  );
  return Number(rows[0].id);
}

export async function findOrder(id, userId) {
  const { rows } = await pool.query(
    "SELECT id, product_name, amount, currency, status FROM orders WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0];
}
