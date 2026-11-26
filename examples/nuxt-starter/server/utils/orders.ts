import { randomUUID } from "node:crypto";
import type { H3Event } from "h3";

export const VISITOR_COOKIE = "visitor";

// The shop's one product. Prices are decimal strings: OpenReceive converts the
// order's own amount into the Lightning invoice and never reads a price from
// the browser.
export const product = { name: "Demo sticker", price: "5.00", currency: "USD" };

export interface Order {
  id: string;
  visitor: string;
  product_name: string;
  amount: string;
  currency: string;
  state: string;
}

/** Creates the order before checkout; its id is the OpenReceive reference. */
export async function createOrder(visitor: string): Promise<string> {
  const id = randomUUID();
  await db().query(
    "INSERT INTO orders (id, visitor, product_name, amount, currency) VALUES ($1, $2, $3, $4, $5)",
    [id, visitor, product.name, product.price, product.currency],
  );
  return id;
}

export async function findOrder(id: string): Promise<Order | undefined> {
  const { rows } = await db().query<Order>(
    "SELECT id, visitor, product_name, amount, currency, state FROM orders WHERE id = $1",
    [id],
  );
  return rows[0];
}

/** The order, only if this browser created it. */
export async function findOwnOrder(event: H3Event, id: string): Promise<Order | undefined> {
  const order = await findOrder(id);
  const visitor = getCookie(event, VISITOR_COOKIE);
  return order && visitor && order.visitor === visitor ? order : undefined;
}
