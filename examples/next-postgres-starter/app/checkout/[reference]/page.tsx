import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatPrice } from "@/lib/catalog";
import { walletConfigured } from "@/lib/config";
import { findOwnOrder } from "@/lib/orders";
import { Setup } from "../../setup";
import { OrderCheckout } from "./order-checkout";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your Order", robots: { index: false } };

// The order's own URL. A payer can reload or bookmark it to come back to a
// pending payment or a swap refund.
export default async function CheckoutPage({ params }: { params: Promise<{ reference: string }> }) {
  const { reference } = await params;
  const order = await findOwnOrder(reference);
  if (!order) notFound();
  if (!walletConfigured()) return <Setup />;
  const paid = order.state === "paid";
  const total = formatPrice(order.amount, order.currency);
  return (
    <div className="order">
      <section className="card summary" aria-labelledby="order-title">
        <p className="eyebrow">Your order</p>
        <h1 id="order-title">{order.product_name}</h1>
        <p className={`status ${paid ? "paid" : "pending"}`} role="status">
          {paid ? "Paid" : "Awaiting payment"}
        </p>
        <dl>
          <div>
            <dt>Total</dt>
            <dd>{total}</dd>
          </div>
          <div>
            <dt>Order</dt>
            <dd className="mono" translate="no">
              {order.id.slice(0, 8)}
            </dd>
          </div>
          <div>
            <dt>Pay with</dt>
            <dd>Bitcoin Lightning</dd>
          </div>
        </dl>
        <p className="note">Bookmark this page to come back to your order.</p>
      </section>
      <section className="pay" aria-label="Payment">
        <OrderCheckout reference={order.id} paid={paid} />
      </section>
    </div>
  );
}
