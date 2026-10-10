import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const catalog = [
  ["Facet", "7.00", "facet"],
  ["Bezel", "12.00", "bezel"],
  ["Hinge", "4.00", "hinge"],
  ["Latch", "9.00", "latch"],
  ["Knob", "3.00", "knob"],
];

let db;

function database() {
  if (db) return db;
  mkdirSync("/data", { recursive: true });
  db = new DatabaseSync("/data/shop.sqlite");
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
  const insertProduct = db.prepare(
    "INSERT INTO products (name, price, sku) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = ?)",
  );
  for (const [name, price, sku] of catalog) insertProduct.run(name, price, sku, sku);
  return db;
}

export function listProducts() {
  if (process.env.NEXT_PHASE === "phase-production-build") {
    return catalog.map(([name, price], index) => ({ id: index + 1, name, price }));
  }
  return database().prepare("SELECT id, name, price FROM products ORDER BY id").all();
}

export function findProduct(id) {
  return database().prepare("SELECT name, price FROM products WHERE id = ?").get(id);
}

export function findUser(id) {
  return database().prepare("SELECT id FROM users WHERE id = ?").get(id);
}

export function createUser(id) {
  database().prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(id, new Date().toISOString());
}

export function createOrder(userId, product) {
  const created = database()
    .prepare(
      "INSERT INTO orders (user_id, product_name, amount, currency, status) VALUES (?, ?, ?, 'USD', 'awaiting_payment')",
    )
    .run(userId, product.name, product.price);
  return Number(created.lastInsertRowid);
}

export function findOrder(id, userId) {
  return database()
    .prepare(
      "SELECT id, product_name, amount, currency, status FROM orders WHERE id = ? AND user_id = ?",
    )
    .get(id, userId);
}
