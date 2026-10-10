import { createFileRoute, notFound } from "@tanstack/react-router";
import { getOrder } from "@/lib/shop.functions";

export const Route = createFileRoute("/orders/$id")({
  loader: async ({ params }) => {
    const order = await getOrder({ data: params.id });
    if (!order) throw notFound();
    return order;
  },
  component: OrderPage,
});

function OrderPage() {
  const order = Route.useLoaderData();
  return (
    <main>
      <h1>Order {order.id}</h1>
      <p>
        {order.title}: {order.total} {order.currency}
      </p>
      <p>Status: {order.status}</p>
      <p>Payment is not set up yet.</p>
    </main>
  );
}
