import { widgetUser } from "./cookies.server";
import { db } from "./db.server";

export interface Product {
  id: number;
  name: string;
  price: string;
}

export interface Order {
  id: number;
  product_name: string;
  amount: string;
  currency: string;
  status: string;
}

const catalog = [
  ["Facet", "7.00", "facet"],
  ["Bezel", "12.00", "bezel"],
  ["Hinge", "4.00", "hinge"],
  ["Latch", "9.00", "latch"],
  ["Knob", "3.00", "knob"],
] as const;

let ready: Promise<void> | undefined;

async function createShop(): Promise<void> {
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
  for (const [name, price, sku] of catalog) {
    await db().query(
      "INSERT INTO products (name, price, sku) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = $3)",
      [name, price, sku],
    );
  }
}

/** The tables and the catalog, created once per server process if missing. */
export function shopReady(): Promise<void> {
  ready ??= createShop().catch((error: unknown) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

export async function listProducts(): Promise<Product[]> {
  await shopReady();
  const { rows } = await db().query<Product>("SELECT id, name, price FROM products ORDER BY id");
  return rows;
}

export async function findProduct(id: number): Promise<Product | undefined> {
  await shopReady();
  const { rows } = await db().query<Product>(
    "SELECT id, name, price FROM products WHERE id = $1",
    [id],
  );
  return rows[0];
}

/** The signed-in user's id from the `widget_user` cookie, if that user exists. */
export async function currentUserId(request: Request): Promise<string | undefined> {
  const id: unknown = await widgetUser.parse(request.headers.get("Cookie"));
  if (typeof id !== "string") return undefined;
  await shopReady();
  const { rows } = await db().query<{ id: string }>("SELECT id FROM users WHERE id = $1", [id]);
  return rows[0]?.id;
}

export async function createUser(id: string): Promise<void> {
  await shopReady();
  await db().query("INSERT INTO users (id) VALUES ($1)", [id]);
}

/** Copies the product's current price into a new order. */
export async function createOrder(userId: string, product: Product): Promise<number> {
  await shopReady();
  const { rows } = await db().query<{ id: number }>(
    "INSERT INTO orders (user_id, product_name, amount, currency, status) VALUES ($1, $2, $3, 'USD', 'awaiting_payment') RETURNING id",
    [userId, product.name, product.price],
  );
  return rows[0].id;
}

/** The order, only when this user placed it. */
export async function findOrder(id: number, userId: string): Promise<Order | undefined> {
  await shopReady();
  const { rows } = await db().query<Order>(
    "SELECT id, product_name, amount, currency, status FROM orders WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0];
}
