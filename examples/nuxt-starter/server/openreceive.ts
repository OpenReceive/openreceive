import { defineOpenReceive } from "@openreceive/nuxt/server";

// The three hooks the module's payment routes call. db, findOrder and
// getCookie are Nitro auto-imports. NWC_URI (and LSC_URI_PRIMARY for swaps)
// are read from the server's environment on the first payment request.
export default defineOpenReceive({
  storage: {
    db: db(),
    // Runs once, inside the settlement transaction. `$1` placeholders.
    onPaid: async ({ reference, paidAt, query }) => {
      await query(
        "UPDATE orders SET state = 'paid', paid_at = $1 WHERE id = $2 AND state = 'awaiting_payment'",
        [paidAt, reference],
      );
    },
  },
  // The price comes from the order row, never from the request.
  amountFor: async (reference) => {
    const order = await findOrder(reference);
    return order?.state === "awaiting_payment"
      ? { currency: order.currency, value: order.amount, description: order.product_name }
      : null;
  },
  // Only the browser that created the order may pay for it.
  authorize: async ({ native, resource }) => {
    const order = resource.reference ? await findOrder(resource.reference) : undefined;
    return Boolean(order && order.visitor === getCookie(native, VISITOR_COOKIE));
  },
  // 60 new invoices an hour per client IP, counted in the database.
  rateLimiting: true,
});
