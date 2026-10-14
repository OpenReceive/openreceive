import { db, ready } from "./db";

export interface Product {
  id: number;
  name: string;
  /** A decimal string, e.g. "7.00". */
  price: string;
}

export type OrderStatus = "awaiting_payment" | "paid";

export interface Order {
  id: number;
  product_name: string;
  /** A decimal string, copied from the product when the order is placed. */
  amount: string;
  currency: string;
  status: OrderStatus;
}

export async function listProducts(): Promise<Product[]> {
  await ready();
  const { rows } = await db().query<Product>("SELECT id, name, price FROM products ORDER BY id");
  return rows;
}

export async function findProduct(id: number): Promise<Product | undefined> {
  if (!Number.isSafeInteger(id)) return undefined;
  await ready();
  const { rows } = await db().query<Product>("SELECT id, name, price FROM products WHERE id = $1", [id]);
  return rows[0];
}

export async function userExists(id: string): Promise<boolean> {
  await ready();
  const { rowCount } = await db().query("SELECT 1 FROM users WHERE id = $1", [id]);
  return rowCount === 1;
}

export async function createUser(id: string): Promise<void> {
  await ready();
  await db().query("INSERT INTO users (id) VALUES ($1)", [id]);
}

/** Copies the product's current price into a new order and returns its id. */
export async function createOrder(userId: string, product: Product): Promise<number> {
  await ready();
  const { rows } = await db().query<{ id: number }>(
    `INSERT INTO orders (user_id, product_name, amount, currency, status)
     VALUES ($1, $2, $3, 'USD', 'awaiting_payment') RETURNING id`,
    [userId, product.name, product.price],
  );
  return rows[0].id;
}

/** The order, only when this user placed it. */
export async function findOrder(id: number, userId: string | undefined): Promise<Order | undefined> {
  if (userId === undefined || !Number.isSafeInteger(id)) return undefined;
  await ready();
  const { rows } = await db().query<Order>(
    "SELECT id, product_name, amount, currency, status FROM orders WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0];
}
