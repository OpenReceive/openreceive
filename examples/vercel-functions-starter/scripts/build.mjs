// The build step, run by every Vercel deploy ("build" in package.json): it
// creates the tables if they are missing, then copies the checkout element's
// standalone files into public/. Every statement is idempotent.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { paymentsSchemaSql } from "@openreceive/http";
import pg from "pg";

const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error("No database URL. Add Neon from the project's Storage tab.");
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      visitor TEXT NOT NULL,
      title TEXT NOT NULL,
      amount TEXT NOT NULL,
      currency TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'awaiting_payment',
      paid_at BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // A swap's payment hash, so a payer who comes back for a refund gets that swap.
  await client.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS swap_payment_hash TEXT");
  await client.query(paymentsSchemaSql("postgres"));
  console.log("Database tables are ready.");
} finally {
  await client.end();
}

const require = createRequire(import.meta.url);
const standalone = path.dirname(
  require.resolve("@openreceive/elements/standalone/openreceive-checkout.js"),
);
mkdirSync("public/openreceive-checkout", { recursive: true });
for (const file of ["openreceive-checkout.js", "openreceive-checkout.css"]) {
  copyFileSync(path.join(standalone, file), path.join("public/openreceive-checkout", file));
}
console.log("Checkout files copied to public/openreceive-checkout/.");
