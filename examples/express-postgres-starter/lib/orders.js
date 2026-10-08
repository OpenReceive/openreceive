import { randomUUID } from "node:crypto";
import { db } from "./db.js";

export const VISITOR_COOKIE = "visitor";

/** The visitor id from a raw Cookie header, or undefined. */
export function visitorFrom(cookieHeader) {
  for (const part of (cookieHeader ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === VISITOR_COOKIE) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

/** Creates the order before checkout; its id is the OpenReceive reference. */
export async function createOrder(visitor, product) {
  const id = randomUUID();
  await db().query(
    "INSERT INTO orders (id, visitor, product_name, amount, currency) VALUES ($1, $2, $3, $4, $5)",
    [id, visitor, product.name, product.price, product.currency],
  );
  return id;
}

export async function findOrder(id) {
  const { rows } = await db().query(
    "SELECT id, visitor, product_name, amount, currency, state FROM orders WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/** The order, only if this visitor created it. */
export async function findOwnOrder(id, visitor) {
  const order = await findOrder(id);
  return order && visitor && order.visitor === visitor ? order : null;
}
