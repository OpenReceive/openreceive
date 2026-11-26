import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { paymentsSchemaSql } from "@openreceive/http";

// One SQLite file for the shop's orders and OpenReceive's two tables, made on
// first import. A real app runs the payment tables through its migrations.
export const db = new DatabaseSync(process.env.SHOP_DB ?? ":memory:");
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  visitor TEXT NOT NULL,
  title TEXT NOT NULL,
  sats INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'awaiting_payment',
  paid_at INTEGER
)`);
db.exec(paymentsSchemaSql("sqlite"));

export interface Order {
  id: string;
  visitor: string;
  title: string;
  sats: number;
  state: string;
}

export function findOrder(id: string): Order | undefined {
  return db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as Order | undefined;
}

export function createOrder(visitor: string): Order {
  const order = {
    id: randomUUID(),
    visitor,
    title: "A widget",
    sats: 5000,
    state: "awaiting_payment",
  };
  db.prepare("INSERT INTO orders (id, visitor, title, sats) VALUES (?, ?, ?, ?)").run(
    order.id,
    order.visitor,
    order.title,
    order.sats,
  );
  return order;
}
