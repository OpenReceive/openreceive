import { pool } from "./db.js";

// The buyer is a random id in a cookie, kept on the order row: a guess cannot
// match another buyer's order, so the cookie needs no signing secret.
export const VISITOR_COOKIE = "visitor";
const YEAR_SECONDS = 365 * 24 * 60 * 60;

export function visitorCookie(visitor) {
  return `${VISITOR_COOKIE}=${visitor}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${YEAR_SECONDS}`;
}

export function visitorFrom(request) {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === VISITOR_COOKIE)?.[1];
}

export async function findOrder(id) {
  const { rows } = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
  return rows[0];
}

export async function createOrder(visitor, product) {
  const id = crypto.randomUUID();
  await pool.query(
    "INSERT INTO orders (id, visitor, title, amount, currency) VALUES ($1, $2, $3, $4, $5)",
    [id, visitor, product.title, product.amount, product.currency],
  );
  return id;
}
