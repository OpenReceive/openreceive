import { randomUUID } from "node:crypto";

// Buy: places an order for this browser and opens its page.
export default defineEventHandler(async (event) => {
  let visitor = getCookie(event, VISITOR_COOKIE);
  if (!visitor) {
    visitor = randomUUID();
    setCookie(event, VISITOR_COOKIE, visitor, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
  }
  const id = await createOrder(visitor);
  return sendRedirect(event, `/orders/${id}`, 303);
});
