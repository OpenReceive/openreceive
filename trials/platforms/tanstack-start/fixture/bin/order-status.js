import { pool } from "./db.js";

const id = Number(process.argv[2]);
const { rows } = Number.isInteger(id)
  ? await pool.query("SELECT status FROM orders WHERE id = $1", [id])
  : { rows: [] };
console.log(rows[0]?.status ?? "");
await pool.end();
