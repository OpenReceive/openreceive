import { pool } from "./db.js";

const { rows } = await pool.query("SELECT status FROM orders WHERE id = $1", [Number(process.argv[2])]);
console.log(rows[0]?.status ?? "");
await pool.end();
