import { guestFrom } from "../lib/session.js";
import { findOrder } from "../lib/shop.js";

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ENTITIES[char]);

function page(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escape(title)} · Widget Shop</title>
    <link rel="stylesheet" href="/style.css" />
  </head>
  <body>
    <main>
      <p><a href="/">Widget Shop</a></p>
      ${body}
    </main>
  </body>
</html>
`;
}

// GET /orders/:id, which vercel.json rewrites here (the id arrives as ?id=).
export default async function handler(req, res) {
  const guest = guestFrom(req.headers.cookie);
  const order = guest ? await findOrder(Number(req.query.id), guest) : undefined;
  if (!order) return res.status(404).send(page("Not found", "<h1>Order not found</h1>"));
  const state =
    order.status === "paid"
      ? "Paid. Thank you!"
      : "Awaiting payment. Online payments are not set up yet.";
  return res.send(
    page(
      `Order ${order.id}`,
      `<h1>Order ${order.id}</h1>
      <p>${escape(order.product_name)} — $${escape(order.amount)} ${escape(order.currency)}</p>
      <p>${state}</p>`,
    ),
  );
}
