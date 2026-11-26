import { paymentsSchemaSql } from "@openreceive/http";

// The shop's orders table and OpenReceive's payment tables, created when the
// server starts (never during `nuxt build`). Every statement is idempotent.
// A real app runs these through its own migrations.
export default defineNitroPlugin(async () => {
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
});
