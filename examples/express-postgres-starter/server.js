import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openReceiveExpress } from "@openreceive/express";
import express from "express";
import { product } from "./lib/catalog.js";
import { db } from "./lib/db.js";
import { createOrder, findOrder, findOwnOrder, VISITOR_COOKIE, visitorFrom } from "./lib/orders.js";
import { createTables } from "./lib/schema.js";

// The drop-in checkout as one ES module and one stylesheet, served straight
// from the installed package: no build step.
const checkoutAssets = path.dirname(
  fileURLToPath(import.meta.resolve("@openreceive/elements/standalone/openreceive-checkout.js")),
);

const app = express();
// Replit's proxy sets X-Forwarded-For, so the rate limiter sees each payer's IP.
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/checkout-assets", express.static(checkoutAssets));

// The payment routes, under /openreceive. NWC_URI and LSC_URI_PRIMARY are
// Secrets. Settlement runs during requests to these routes: no worker, cron
// job or timer is needed.
app.use(
  openReceiveExpress({
    wallet: { nwc: process.env.NWC_URI ?? "" },
    storage: {
      db: db(),
      // Runs once, inside the settlement transaction. `$1` placeholders.
      onPaid: async ({ reference, paidAt, query }) => {
        await query(
          "UPDATE orders SET state = 'paid', paid_at = $1 WHERE id = $2 AND state = 'awaiting_payment'",
          [paidAt, reference],
        );
      },
    },
    // The price comes from the order row, never from the request.
    amountFor: async (reference) => {
      const order = await findOrder(reference);
      return order && order.state === "awaiting_payment"
        ? { currency: order.currency, value: order.amount, description: order.product_name }
        : null;
    },
    // Only the browser that created the order may pay for it.
    authorize: async ({ request, resource }) => {
      const visitor = visitorFrom(request.headers.get("cookie"));
      const order = resource.reference ? await findOrder(resource.reference) : null;
      return Boolean(order && visitor && order.visitor === visitor);
    },
    rateLimiting: true,
  }),
);

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/checkout-assets/openreceive-checkout.css">
<script type="module" src="/checkout-assets/openreceive-checkout.js"></script>
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

app.get("/", (_req, res) => {
  res.type("html").send(
    page(
      product.name,
      `<h1>${escapeHtml(product.name)}</h1>
<p>$${escapeHtml(product.price)} ${escapeHtml(product.currency)}, paid in bitcoin over Lightning, straight to the shop's wallet.</p>
<form method="post" action="/orders"><button type="submit">Buy</button></form>`,
    ),
  );
});

app.post("/orders", async (req, res) => {
  let visitor = visitorFrom(req.headers.cookie);
  if (!visitor) {
    visitor = randomUUID();
    res.cookie(VISITOR_COOKIE, visitor, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure,
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
  }
  const id = await createOrder(visitor, product);
  res.redirect(303, `/orders/${id}`);
});

// The order's own URL. A payer can reload or bookmark it to come back to a
// pending payment or a swap refund.
app.get("/orders/:id", async (req, res) => {
  const order = await findOwnOrder(req.params.id, visitorFrom(req.headers.cookie));
  if (!order) {
    res.status(404).type("html").send(page("Not found", "<h1>Order not found</h1>"));
    return;
  }
  const status = order.state === "paid" ? "Paid, thank you." : "Awaiting payment";
  res.type("html").send(
    page(
      order.product_name,
      `<h1>${escapeHtml(order.product_name)}</h1>
<p>$${escapeHtml(order.amount)} ${escapeHtml(order.currency)} · ${status}</p>
<openreceive-checkout reference="${escapeHtml(order.id)}" prefix="/openreceive"></openreceive-checkout>`,
    ),
  );
});

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok\n");
});

await createTables();
const port = Number(process.env.PORT ?? 5000);
// 0.0.0.0, not localhost: a published Replit app is reached from outside.
app.listen(port, "0.0.0.0", () => console.log(`Shop listening on port ${port}`));
