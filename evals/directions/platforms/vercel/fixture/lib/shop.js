import { db } from "./db.js";

export async function listProducts() {
  const { rows } = await db().query("SELECT id, name, price FROM products ORDER BY id");
  return rows;
}

export async function findProduct(id) {
  const { rows } = await db().query("SELECT name, price FROM products WHERE id = $1", [id]);
  return rows[0];
}

export async function findUser(id) {
  const { rows } = await db().query("SELECT id FROM users WHERE id = $1", [id]);
  return rows[0];
}

export async function createUser(id) {
  await db().query("INSERT INTO users (id, created_at) VALUES ($1, now())", [id]);
}

export async function createOrder(userId, product) {
  const { rows } = await db().query(
    "INSERT INTO orders (user_id, product_name, amount, currency, status) VALUES ($1, $2, $3, 'USD', 'awaiting_payment') RETURNING id",
    [userId, product.name, product.price],
  );
  return Number(rows[0].id);
}

export async function findOrder(id, userId) {
  const { rows } = await db().query(
    "SELECT id, product_name, amount, currency, status FROM orders WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0];
}
