import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import express from "express";

const db = new DatabaseSync("/data/shop.sqlite");
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    price TEXT NOT NULL,
    sku TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    user_id TEXT NOT NULL,
    product_name TEXT NOT NULL,
    amount TEXT NOT NULL,
    currency TEXT NOT NULL,
    status TEXT NOT NULL
  );
`);

const catalog = [
  ["Facet", "7.00", "facet"],
  ["Bezel", "12.00", "bezel"],
  ["Hinge", "4.00", "hinge"],
  ["Latch", "9.00", "latch"],
  ["Knob", "3.00", "knob"],
];
const insertProduct = db.prepare(
  "INSERT INTO products (name, price, sku) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = ?)",
);
for (const [name, price, sku] of catalog) insertProduct.run(name, price, sku, sku);

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

function currentUser(req, res) {
  const existing = readCookie(req, "widget_user");
  if (existing) {
    const row = db.prepare("SELECT id FROM users WHERE id = ?").get(existing);
    if (row) return row.id;
  }
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(id, new Date().toISOString());
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

app.get("/", (_req, res) => {
  const products = db.prepare("SELECT id, name, price FROM products ORDER BY id").all();
  const items = products
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
});

app.post("/orders", (req, res) => {
  const userId = currentUser(req, res);
  const product = db.prepare("SELECT name, price FROM products WHERE id = ?").get(Number(req.body.product_id));
  if (!product) {
    res.status(404).type("html").send(page("Not found", "<p>That product is not in the catalog.</p>"));
    return;
  }
  const created = db
    .prepare(
      "INSERT INTO orders (user_id, product_name, amount, currency, status) VALUES (?, ?, ?, 'USD', 'awaiting_payment')",
    )
    .run(userId, product.name, product.price);
  res.redirect(303, `/orders/${created.lastInsertRowid}`);
});

app.get("/orders/:id", (req, res) => {
  const userId = currentUser(req, res);
  const order = db
    .prepare(
      "SELECT id, product_name, amount, currency, status FROM orders WHERE id = ? AND user_id = ?",
    )
    .get(Number(req.params.id), userId);
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
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, "0.0.0.0");
