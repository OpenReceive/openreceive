/**
 * Host-owned Hello Fruit persistence using local SQLite (node:sqlite).
 *
 * Mirrors the scaffold payments shape: orders are host rows; each
 * openreceive_payments row is one invoice/swap attempt. Every demo boot wipes
 * the local file and recreates schema so the checkout surface stays disposable
 * while still showing the real host DB pattern.
 *
 * OpenReceive itself never opens this database — the demo owns the path.
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  openReceivePaymentInsert,
  type OpenReceiveHostRepository,
  type OpenReceivePaymentRecord,
} from "@openreceive/http";
import type { CreateCheckoutAmount, SwapData } from "@openreceive/node";
import type { HelloFruitDemoOrder } from "./demo-order.ts";

export interface HelloFruitStoredOrder {
  readonly summary: HelloFruitDemoOrder;
  readonly amount: CreateCheckoutAmount;
}

interface HelloFruitStoredPayment extends OpenReceivePaymentRecord {
  readonly swapData?: SwapData | null;
}

interface PaymentRow {
  order_id: string;
  payment_hash: string;
  paid_at: number | null;
  expires_at: number;
  created_at: number;
  checkout_data: string;
  swap_data: string | null;
}

interface OrderRow {
  id: string;
  summary_json: string;
  amount_json: string;
  status: string;
}

type DemoStoreLogger = (event: string, message: string, fields?: Record<string, unknown>) => void;

const HELLO_FRUIT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OPENRECEIVE_DIR = path.join(HELLO_FRUIT_ROOT, ".openreceive");

let db: DatabaseSync | undefined;
let activeDemoId: string | undefined;

export function closeHelloFruitHostStore(): void {
  if (db === undefined) return;
  db.close();
  db = undefined;
  activeDemoId = undefined;
}

export async function bootHelloFruitHostStore(input: {
  readonly demoId: string;
  readonly log: DemoStoreLogger;
}): Promise<string> {
  if (db !== undefined && activeDemoId === input.demoId) {
    return dbPathFor(input.demoId);
  }
  closeHelloFruitHostStore();

  await mkdir(OPENRECEIVE_DIR, { recursive: true });
  const dbPath = dbPathFor(input.demoId);
  input.log("host.store.wipe", "Wiping local host SQLite database for a fresh demo boot.", {
    demoId: input.demoId,
    path: dbPath,
  });
  await rmSqliteFiles(dbPath);

  input.log("host.store.migrate", "Creating host orders + openreceive_payments tables.", {
    dialect: "sqlite",
    path: dbPath,
  });
  const next = new DatabaseSync(dbPath);
  next.exec("PRAGMA foreign_keys = ON;");
  next.exec("PRAGMA journal_mode = WAL;");
  next.exec(`
    CREATE TABLE orders (
      id TEXT PRIMARY KEY NOT NULL,
      summary_json TEXT NOT NULL,
      amount_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE openreceive_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
      payment_hash TEXT NOT NULL UNIQUE,
      paid_at INTEGER,
      expires_at INTEGER NOT NULL,
      checkout_data TEXT NOT NULL,
      swap_data TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX openreceive_payments_order_created_idx
      ON openreceive_payments (order_id, created_at);
    CREATE INDEX openreceive_payments_paid_created_idx
      ON openreceive_payments (paid_at, created_at);

  `);

  db = next;
  activeDemoId = input.demoId;
  input.log("host.store.ready", "Host SQLite store is ready.", {
    demoId: input.demoId,
    path: dbPath,
  });
  return dbPath;
}

export function createHelloFruitHostOrder(
  summary: HelloFruitDemoOrder,
  amount: CreateCheckoutAmount,
): HelloFruitStoredOrder {
  const database = requireDb();
  const now = Math.floor(Date.now() / 1_000);
  const stored: HelloFruitStoredOrder = { summary, amount };
  database
    .prepare(
      `INSERT INTO orders (id, summary_json, amount_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(summary.uuid, JSON.stringify(summary), JSON.stringify(amount), summary.status, now, now);
  return stored;
}

export function readHelloFruitHostOrder(orderId: string): HelloFruitStoredOrder | null {
  const row = requireDb()
    .prepare(`SELECT id, summary_json, amount_json, status FROM orders WHERE id = ?`)
    .get(orderId) as OrderRow | undefined;
  if (row === undefined) return null;
  return {
    summary: JSON.parse(row.summary_json) as HelloFruitDemoOrder,
    amount: JSON.parse(row.amount_json) as CreateCheckoutAmount,
  };
}

export const helloFruitPaymentRepository: OpenReceiveHostRepository = {
  async listForOrder(orderId) {
    const rows = requireDb()
      .prepare(
        `SELECT order_id, payment_hash, paid_at, expires_at, created_at, checkout_data, swap_data
         FROM openreceive_payments
         WHERE order_id = ?
         ORDER BY created_at DESC, payment_hash DESC`,
      )
      .all(orderId) as PaymentRow[];
    return rows.map(mapPaymentRow);
  },

  async commitAttempt(input) {
    const database = requireDb();
    const values = openReceivePaymentInsert(input);
    const now = Math.floor(Date.now() / 1_000);

    database.exec("BEGIN IMMEDIATE");
    try {
      const order = database.prepare(`SELECT id FROM orders WHERE id = ?`).get(values.orderId) as
        | { id: string }
        | undefined;
      if (order === undefined) throw new Error("Host order not found.");

      const same = database
        .prepare(`SELECT order_id, payment_hash FROM openreceive_payments WHERE payment_hash = ?`)
        .get(values.paymentHash) as { order_id: string; payment_hash: string } | undefined;
      if (same !== undefined) {
        if (same.order_id !== values.orderId) {
          throw new Error("payment hash belongs to another order");
        }
        database.exec("COMMIT");
        return;
      }

      const blocking = database
        .prepare(
          `SELECT payment_hash FROM openreceive_payments
           WHERE order_id = ?
             AND (paid_at IS NOT NULL OR (paid_at IS NULL AND expires_at > ?))
           LIMIT 1`,
        )
        .get(values.orderId, now) as { payment_hash: string } | undefined;
      if (blocking !== undefined) {
        throw new Error("Order already has a paid or live payment attempt.");
      }

      database
        .prepare(
          `INSERT INTO openreceive_payments
            (order_id, payment_hash, paid_at, expires_at, checkout_data, swap_data, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          values.orderId,
          values.paymentHash,
          values.expiresAt,
          JSON.stringify(values.checkout),
          values.swapData === undefined || values.swapData === null
            ? null
            : JSON.stringify(values.swapData),
          values.createdAt,
          now,
        );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  },

  async listUnsettledAttempts() {
    return (
      requireDb()
        .prepare(
          `SELECT payment_hash, created_at
           FROM openreceive_payments
           WHERE paid_at IS NULL`,
        )
        .all() as { payment_hash: string; created_at: number }[]
    ).map((row) => ({
      paymentHash: row.payment_hash,
      createdAt: row.created_at,
    }));
  },
};

/**
 * Write-once settlement per attempt. The first settled attempt fulfills the
 * order; later settled attempts remain recorded without repeating fulfillment.
 */
export function markHelloFruitPaid(
  paymentHash: string,
  paidAt: number,
): HelloFruitStoredOrder | null {
  const database = requireDb();
  database.exec("BEGIN IMMEDIATE");
  try {
    const payment = database
      .prepare(
        `SELECT order_id, payment_hash, paid_at, expires_at, created_at, checkout_data, swap_data
         FROM openreceive_payments WHERE payment_hash = ?`,
      )
      .get(paymentHash.toLowerCase()) as PaymentRow | undefined;
    if (payment === undefined) {
      database.exec("ROLLBACK");
      return null;
    }

    database.prepare(`SELECT id FROM orders WHERE id = ?`).get(payment.order_id);

    if (payment.paid_at === null) {
      database
        .prepare(
          `UPDATE openreceive_payments
           SET paid_at = ?, updated_at = ?
           WHERE payment_hash = ? AND paid_at IS NULL`,
        )
        .run(paidAt, Math.floor(Date.now() / 1_000), payment.payment_hash);
    }

    const order = readOrderRow(payment.order_id);
    if (order === null) {
      database.exec("ROLLBACK");
      return null;
    }

    if (order.summary.status !== "paid") {
      const nextSummary: HelloFruitDemoOrder = { ...order.summary, status: "paid" };
      database
        .prepare(
          `UPDATE orders
           SET summary_json = ?, status = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(nextSummary), "paid", Math.floor(Date.now() / 1_000), payment.order_id);
      database.exec("COMMIT");
      return { summary: nextSummary, amount: order.amount };
    }

    database.exec("COMMIT");
    return order;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function readOrderRow(orderId: string): HelloFruitStoredOrder | null {
  const row = requireDb()
    .prepare(`SELECT id, summary_json, amount_json, status FROM orders WHERE id = ?`)
    .get(orderId) as OrderRow | undefined;
  if (row === undefined) return null;
  return {
    summary: JSON.parse(row.summary_json) as HelloFruitDemoOrder,
    amount: JSON.parse(row.amount_json) as CreateCheckoutAmount,
  };
}

function mapPaymentRow(row: PaymentRow): HelloFruitStoredPayment {
  return {
    orderId: row.order_id,
    paymentHash: row.payment_hash,
    paidAt: row.paid_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    checkout: JSON.parse(row.checkout_data) as OpenReceivePaymentRecord["checkout"],
    ...(row.swap_data === null ? {} : { swapData: JSON.parse(row.swap_data) as SwapData }),
  };
}

function requireDb(): DatabaseSync {
  if (db === undefined) {
    throw new Error(
      "Hello Fruit host store is not booted. Call bootHelloFruitHostStore() during server startup.",
    );
  }
  return db;
}

function dbPathFor(demoId: string): string {
  return path.join(OPENRECEIVE_DIR, `${demoId}.sqlite`);
}

async function rmSqliteFiles(dbPath: string): Promise<void> {
  await Promise.all([
    rm(dbPath, { force: true }),
    rm(`${dbPath}-wal`, { force: true }),
    rm(`${dbPath}-shm`, { force: true }),
  ]);
}
