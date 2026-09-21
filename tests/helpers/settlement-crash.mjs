import { DatabaseSync } from "node:sqlite";
import { createHost, createSqlPayments } from "../../packages/js/http/src/index.ts";
const [file, boundary] = process.argv.slice(2);
const db = new DatabaseSync(file);
const host = createHost({
  payments: createSqlPayments(db),
  amountFor: () => ({ sats: 1 }),
  onPaid: async ({ reference, transaction }) => {
    await transaction.query("INSERT INTO entitlements VALUES (?)", [reference]);
    if (boundary === "before") {
      process.send("before_commit");
      await new Promise(() => {});
    }
  },
});
await host.onPaid({ paymentHash: "a".repeat(64), paidAt: 1050 });
process.send("after_commit");
// Keep the process alive for termination at the selected boundary.
setInterval(() => {}, 1000);
