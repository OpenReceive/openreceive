import pg from "pg";

/** Replit's Postgres. Replit sets DATABASE_URL for the app. */
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
