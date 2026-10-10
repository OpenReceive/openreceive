import { createFileRoute } from "@tanstack/react-router";

// The Buy form posts here. The order is created on the server, with the price
// copied from the product, and the buyer lands on the order's page.
export const Route = createFileRoute("/orders")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { createOrder } = await import("@/lib/shop.server");
        const form = await request.formData();
        const order = await createOrder(Number(form.get("product_id")));
        if (!order) return new Response("Unknown product", { status: 404 });
        return new Response(null, { status: 303, headers: { location: `/orders/${order.id}` } });
      },
    },
  },
});
