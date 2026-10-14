import { randomUUID } from "node:crypto";

// The Buy button's plain form POST. The buyer is a cookie: a visitor gets one
// with their first order.
export default defineEventHandler(async (event) => {
  const body = await readBody<{ product_id?: string }>(event);
  const product = await findProduct(Number(body?.product_id));
  if (!product) {
    throw createError({ statusCode: 404, statusMessage: "That product is not in the catalog." });
  }

  let userId = getCookie(event, "widget_user");
  if (!userId || !(await userExists(userId))) {
    userId = randomUUID();
    await createUser(userId);
    setCookie(event, "widget_user", userId, { httpOnly: true, path: "/", sameSite: "lax" });
  }
  const id = await createOrder(userId, product);
  // A relative Location: the server only knows the address it bound
  // (0.0.0.0:3000 in Docker), not the one the buyer's browser used.
  return sendRedirect(event, `/orders/${id}`, 303);
});
