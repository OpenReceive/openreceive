import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("/data/shop.sqlite", { readOnly: true });
const row = db.prepare("SELECT COUNT(*) AS n FROM products").get();
console.log(row.n);
