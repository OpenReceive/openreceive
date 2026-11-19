// GET /checkout/<order id>, through the rewrite in vercel.json: the order's
// own page. While the order is unpaid it shows the checkout; once paid, the
// page says so.
import { findOrder, visitorFrom } from "../lib/orders.js";

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (char) => ENTITIES[char]);

function page(title, body) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/style.css" />
    <link rel="stylesheet" href="/openreceive-checkout/openreceive-checkout.css" />
    <script type="module" src="/openreceive-checkout/openreceive-checkout.js"></script>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>
`;
}

function html(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// With a swap's hash saved on the order, the checkout reopens that swap, so a
// payer who comes back for a refund finds it, instead of the payment methods.
function checkoutTag(order) {
  const id = escapeHtml(order.id);
  if (!order.swap_payment_hash) {
    return `<openreceive-checkout reference="${id}" prefix="/openreceive" resumable></openreceive-checkout>`;
  }
  const hash = escapeHtml(order.swap_payment_hash);
  return `<openreceive-checkout reference="${id}" prefix="/openreceive" resumable resume-payment-hash="${hash}"></openreceive-checkout>`;
}

export async function GET(request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  const order = await findOrder(id);
  if (!order || order.visitor !== visitorFrom(request)) {
    return html(404, page("Not found", "<h1>Order not found</h1>"));
  }
  if (order.state === "paid") {
    return html(200, page("Paid", `<h1>${escapeHtml(order.title)}</h1><p>Paid. Thank you!</p>`));
  }
  return html(
    200,
    page(
      "Checkout",
      `<h1>${escapeHtml(order.title)}</h1>
      <p id="status">$${escapeHtml(order.amount)}, awaiting payment</p>
      ${checkoutTag(order)}
      <script type="module">
        const checkout = document.querySelector("openreceive-checkout");
        checkout.addEventListener("openreceive-settled", () => {
          document.querySelector("#status").textContent = "Paid. Thank you!";
        });
        // A swap's hash goes on the order, so a refund visit reopens that swap.
        checkout.addEventListener("openreceive-state", (event) => {
          const { state } = event.detail;
          if (state.rail !== "swap" || !state.payment_hash) return;
          fetch("/api/order-swap", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ reference: checkout.getAttribute("reference"), payment_hash: state.payment_hash }),
          });
        });
      </script>`,
    ),
  );
}
