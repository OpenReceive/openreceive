import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/data/shop.sqlite", { readOnly: true });
const row = db
  .prepare("SELECT COUNT(*) AS n FROM fulfillments WHERE reference = ?")
  .get(process.argv[2]);
console.log(row.n);
