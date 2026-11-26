import { randomUUID } from "node:crypto";

// Places an order for this visitor, setting the visitor cookie on the first.
export default defineEventHandler((event) => {
  let visitor = getCookie(event, "visitor");
  if (!visitor) {
    visitor = randomUUID();
    setCookie(event, "visitor", visitor, { httpOnly: true, sameSite: "lax", path: "/" });
  }
  return { id: createOrder(visitor).id };
});
