// The page asks whether this visitor owns the order.
export default defineEventHandler((event) => {
  const order = findOrder(getRouterParam(event, "reference") ?? "");
  if (!order || order.visitor !== getCookie(event, "visitor")) {
    throw createError({ statusCode: 404, statusMessage: "Not found" });
  }
  return { reference: order.id };
});
