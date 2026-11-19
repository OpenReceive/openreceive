// api/order-swap.js — keeps the swap's payment hash on the order
import { pool } from "../lib/db.js";
import { findOrder, visitorFrom } from "../lib/orders.js";

export async function POST(request) {
  const { reference, payment_hash: paymentHash } = await request.json();
  const order = typeof reference === "string" ? await findOrder(reference) : undefined;
  const visitor = visitorFrom(request);
  if (!order || !visitor || order.visitor !== visitor || !/^[0-9a-f]{64}$/.test(paymentHash)) {
    return new Response(null, { status: 403 });
  }
  await pool.query("UPDATE orders SET swap_payment_hash = $1 WHERE id = $2", [
    paymentHash,
    order.id,
  ]);
  return new Response(null, { status: 204 });
}
