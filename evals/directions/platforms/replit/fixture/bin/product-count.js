import { listProducts } from "../lib/shop.js";

console.log((await listProducts()).length);
process.exit(0);
