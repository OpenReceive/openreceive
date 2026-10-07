import { notFound } from "next/navigation";
import { findOwnOrder } from "@/lib/orders";
import { OrderCheckout } from "./order-checkout";

export const dynamic = "force-dynamic";

// The order's own URL. A payer can reload or bookmark it to come back to a
// pending payment or a swap refund.
export default async function CheckoutPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  const order = await findOwnOrder(reference);
  if (!order) notFound();
  return (
    <main>
      <h1>{order.product_name}</h1>
      <p>
        ${order.amount} {order.currency} ·{" "}
        {order.state === "paid" ? "Paid, thank you." : "Awaiting payment"}
      </p>
      <OrderCheckout reference={order.id} />
    </main>
  );
}
