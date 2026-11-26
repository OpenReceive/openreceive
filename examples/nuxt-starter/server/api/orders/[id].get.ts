// The order page asks whether this browser owns the order.
export default defineEventHandler(async (event) => {
  const order = await findOwnOrder(event, getRouterParam(event, "id") ?? "");
  if (!order) throw createError({ statusCode: 404, statusMessage: "Not found" });
  return {
    reference: order.id,
    name: order.product_name,
    amount: order.amount,
    currency: order.currency,
    paid: order.state === "paid",
  };
});
