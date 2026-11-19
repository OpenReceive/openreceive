// lib/db.js — one small pool per function instance
import { attachDatabasePool } from "@vercel/functions";
import pg from "pg";

// Neon's pooled URL. Vercel sets DATABASE_URL in every environment.
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
// Closes idle connections before Vercel suspends the instance.
attachDatabasePool(pool);
