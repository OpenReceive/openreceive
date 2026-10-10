import { db } from "../lib/db.js";

const { rows } = await db().query("SELECT status FROM orders WHERE id = $1", [Number(process.argv[2])]);
console.log(rows[0]?.status ?? "");
process.exit(0);
