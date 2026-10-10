import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/data/shop.sqlite", { readOnly: true });
const row = db.prepare("SELECT status FROM orders WHERE id = ?").get(Number(process.argv[2]));
console.log(row?.status ?? "");
