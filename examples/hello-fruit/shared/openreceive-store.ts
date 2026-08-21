/**
 * Host-owned Hello Fruit persistence using local SQLite (node:sqlite).
 *
 * Orders are host rows; payment attempts live in the library-owned
 * `openreceive_payments` table, created here from the canonical OpenReceive
 * DDL and passed to `createOpenReceiveHost({ db })` as the host database
 * handle. Every demo boot wipes the local file and recreates schema so the
 * checkout surface stays disposable while still showing the real host DB
 * pattern.
 */

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openReceivePaymentsSchemaSql, type OpenReceiveOrderSettlement } from "@openreceive/http";
import type { CreateCheckoutAmount } from "@openreceive/node";
import type { HelloFruitDemoOrder } from "./demo-order.ts";

export interface HelloFruitStoredOrder {
  readonly summary: HelloFruitDemoOrder;
  readonly amount: CreateCheckoutAmount;
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
  `);
  // The payment-attempt schema is library-owned; the host only runs the DDL.
  next.exec(openReceivePaymentsSchemaSql("sqlite"));

  db = next;
  activeDemoId = input.demoId;
  input.log("host.store.ready", "Host SQLite store is ready.", {
    demoId: input.demoId,
    path: dbPath,
  });
  return dbPath;
}

/** The booted host database handle to pass to `createOpenReceiveHost({ db })`. */
export function helloFruitHostDb(): DatabaseSync {
  return requireDb();
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

/**
 * Host fulfillment. Runs inside the OpenReceive settlement transaction (only
 * for the order's first settled attempt) and marks the host order paid.
 */
export async function markHelloFruitOrderPaid(
  settlement: OpenReceiveOrderSettlement,
): Promise<HelloFruitStoredOrder | null> {
  const rows = await settlement.query(`SELECT summary_json, amount_json FROM orders WHERE id = ?`, [
    settlement.orderId,
  ]);
  const row = rows[0];
  if (row === undefined) return null;
  const summary = JSON.parse(String(row.summary_json)) as HelloFruitDemoOrder;
  const amount = JSON.parse(String(row.amount_json)) as CreateCheckoutAmount;
  if (summary.status === "paid") return { summary, amount };

  const paidSummary: HelloFruitDemoOrder = { ...summary, status: "paid" };
  await settlement.query(
    `UPDATE orders SET summary_json = ?, status = 'paid', updated_at = ? WHERE id = ?`,
    [JSON.stringify(paidSummary), Math.floor(Date.now() / 1_000), settlement.orderId],
  );
  return { summary: paidSummary, amount };
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
