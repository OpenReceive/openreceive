// The order, for the visitor who placed it; anyone else gets a 404.
export default defineEventHandler(async (event) => {
  const userId = getCookie(event, "widget_user");
  const order = userId ? await findOrder(Number(getRouterParam(event, "id")), userId) : undefined;
  if (!order) throw createError({ statusCode: 404, statusMessage: "Not Found" });
  return order;
});
