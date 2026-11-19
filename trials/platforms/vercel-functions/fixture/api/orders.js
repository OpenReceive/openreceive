import { guestCookie, guestFrom, newGuest } from "../lib/session.js";
import { createOrder, findProduct } from "../lib/shop.js";

// POST /orders, which vercel.json rewrites here: the Buy buttons' form.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  const product = await findProduct(Number(req.body?.product_id));
  if (!product) return res.status(404).send("That product is not in the catalog.");
  let guest = guestFrom(req.headers.cookie);
  if (!guest) {
    guest = newGuest();
    res.setHeader("set-cookie", guestCookie(guest));
  }
  const id = await createOrder(guest, product);
  return res.redirect(303, `/orders/${id}`);
}
