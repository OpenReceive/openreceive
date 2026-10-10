import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { findOrder } from "../../../lib/shop.js";

export const dynamic = "force-dynamic";

export default async function OrderPage({ params }) {
  const { id } = await params;
  const jar = await cookies();
  const userId = jar.get("widget_user")?.value;
  const order = userId ? await findOrder(Number(id), userId) : undefined;
  if (!order) notFound();
  return (
    <>
      <h1>Order {order.id}</h1>
      <p>
        {order.product_name} — ${order.amount} {order.currency}
      </p>
      <p>Awaiting payment. Online payments are not set up yet.</p>
    </>
  );
}
