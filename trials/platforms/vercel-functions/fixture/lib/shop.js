import { db } from "./db.js";

export async function listProducts() {
  const { rows } = await db().query("SELECT id, name, price FROM products ORDER BY id");
  return rows;
}

export async function findProduct(id) {
  const { rows } = await db().query("SELECT id, name, price FROM products WHERE id = $1", [id]);
  return rows[0];
}

export async function createOrder(guestId, product) {
  const { rows } = await db().query(
    "INSERT INTO orders (guest_id, product_name, amount, currency, status) VALUES ($1, $2, $3, 'USD', 'awaiting_payment') RETURNING id",
    [guestId, product.name, product.price],
  );
  return Number(rows[0].id);
}

/** The guest's own order, or undefined. */
export async function findOrder(id, guestId) {
  const { rows } = await db().query(
    "SELECT id, product_name, amount, currency, status FROM orders WHERE id = $1 AND guest_id = $2",
    [id, guestId],
  );
  return rows[0];
}
