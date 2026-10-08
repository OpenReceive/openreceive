import { paymentsSchemaSql } from "@openreceive/http";
import { db } from "./db.js";

/**
 * Creates the shop's orders table and OpenReceive's payment tables. Every
 * statement is idempotent, so the server runs this at each start, in the
 * editor and in a published app alike.
 */
export async function createTables() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      visitor TEXT NOT NULL,
      product_name TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'awaiting_payment',
      paid_at BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await db().query(paymentsSchemaSql("postgres"));
}
