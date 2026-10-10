import { randomUUID } from "node:crypto";
import express from "express";
import {
  createOrder,
  createUser,
  findOrder,
  findProduct,
  findUser,
  listProducts,
  setupDatabase,
} from "./lib/shop.js";

const app = express();
app.use(express.urlencoded({ extended: false }));

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function readCookie(req, name) {
  const header = req.headers.cookie ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const split = trimmed.indexOf("=");
    if (split === -1) continue;
    if (trimmed.slice(0, split) === name) return decodeURIComponent(trimmed.slice(split + 1));
  }
  return undefined;
}

async function currentUser(req, res) {
  const existing = readCookie(req, "widget_user");
  if (existing && (await findUser(existing))) return existing;
  const id = randomUUID();
  await createUser(id);
  res.append("Set-Cookie", `widget_user=${encodeURIComponent(id)}; HttpOnly; Path=/; SameSite=Lax`);
  return id;
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${body}
</main>
</body>
</html>`;
}

app.get("/health", (_req, res) => {
  res.type("text/plain").send("ok\n");
});

app.get("/", async (_req, res, next) => {
  try {
    const items = (await listProducts())
      .map(
        (product) => `<li>
        ${escapeHtml(product.name)} — $${escapeHtml(product.price)}
        <form method="post" action="/orders">
          <input type="hidden" name="product_id" value="${product.id}">
          <button type="submit">Buy</button>
        </form>
      </li>`,
      )
      .join("");
    res.type("html").send(page("Widget Shop", `<ul>${items}</ul>`));
  } catch (error) {
    next(error);
  }
});

app.post("/orders", async (req, res, next) => {
  try {
    const userId = await currentUser(req, res);
    const product = await findProduct(Number(req.body?.product_id));
    if (!product) {
      res.status(404).type("html").send(page("Not found", "<p>That product is not in the catalog.</p>"));
      return;
    }
    const id = await createOrder(userId, product);
    res.redirect(303, `/orders/${id}`);
  } catch (error) {
    next(error);
  }
});

app.get("/orders/:id", async (req, res, next) => {
  try {
    const userId = await currentUser(req, res);
    const order = await findOrder(Number(req.params.id), userId);
    if (!order) {
      res.status(404).type("html").send(page("Not found", "<p>That order is not yours.</p>"));
      return;
    }
    res.type("html").send(
      page(
        `Order ${order.id}`,
        `<p>${escapeHtml(order.product_name)} — $${escapeHtml(order.amount)} ${escapeHtml(order.currency)}</p>
       <p>Awaiting payment. Online payments are not set up yet.</p>`,
      ),
    );
  } catch (error) {
    next(error);
  }
});

await setupDatabase();
const port = Number(process.env.PORT ?? 5000);
app.listen(port, "0.0.0.0", () => console.log(`Widget Shop on port ${port}`));
