import { cookies } from "next/headers";
import { db } from "./db";

export const VISITOR_COOKIE = "visitor";

export interface Order {
  id: string;
  visitor: string;
  product_name: string;
  amount: string;
  currency: string;
  state: "awaiting_payment" | "paid";
}

export async function findOrder(id: string): Promise<Order | null> {
  const { rows } = await db().query<Order>(
    "SELECT id, visitor, product_name, amount, currency, state FROM orders WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

/** The order, only if this browser created it. */
export async function findOwnOrder(id: string): Promise<Order | null> {
  const visitor = (await cookies()).get(VISITOR_COOKIE)?.value;
  const order = await findOrder(id);
  return order && visitor && order.visitor === visitor ? order : null;
}
