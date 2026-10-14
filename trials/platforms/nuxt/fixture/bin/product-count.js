import { pool } from "./db.js";

const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM products");
console.log(rows[0].n);
await pool.end();
