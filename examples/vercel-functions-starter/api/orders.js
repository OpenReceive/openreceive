// POST /api/orders: the Buy button. Creates the order, then sends the buyer to
// its own checkout page, whose URL stays the same for as long as it is unpaid.
import { createOrder, visitorCookie, visitorFrom } from "../lib/orders.js";

// The price lives here, on the server, never in the page.
const PRODUCT = { title: "Starter widget", amount: "5.00", currency: "USD" };

export async function POST(request) {
  let visitor = visitorFrom(request);
  const headers = new Headers();
  if (!visitor) {
    visitor = crypto.randomUUID();
    headers.append("set-cookie", visitorCookie(visitor));
  }
  const id = await createOrder(visitor, PRODUCT);
  headers.set("location", `/checkout/${id}`);
  return new Response(null, { status: 303, headers });
}
