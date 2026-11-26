import { defineOpenReceive } from "@openreceive/nuxt/server";

// The shop's half: its hooks and its database handle. db, findOrder and
// getCookie are Nitro auto-imports, as they are in any server file.
// openreceive-server-only-marker: the test looks for this line in the
// browser bundle and must not find it.
export default defineOpenReceive({
  storage: {
    db,
    onPaid: async ({ reference, paidAt, query }) => {
      await query(
        "UPDATE orders SET state = 'paid', paid_at = ? WHERE id = ? AND state = 'awaiting_payment'",
        [paidAt, reference],
      );
    },
  },
  amountFor: async (reference) => {
    const order = findOrder(reference);
    return order?.state === "awaiting_payment"
      ? { currency: "SAT", value: String(order.sats), description: order.title }
      : null;
  },
  authorize: async ({ native, resource }) => {
    const order = resource.reference ? findOrder(resource.reference) : undefined;
    return Boolean(order && order.visitor === getCookie(native, "visitor"));
  },
  rateLimiting: true,
});
