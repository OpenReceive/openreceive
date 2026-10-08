// Creates the shop's orders table and OpenReceive's payment tables. Every
// statement is idempotent, so this runs before each `next build` and `next dev`.
import { paymentsSchemaSql } from "@openreceive/http";
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error(
    "No database URL. Connect Neon to this project, or set DATABASE_URL in .env.local.",
  );
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`
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
  await client.query(paymentsSchemaSql("postgres"));
  console.log("Database tables are ready.");
} finally {
  await client.end();
}
