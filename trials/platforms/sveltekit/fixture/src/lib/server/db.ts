import pg from 'pg';
import { DATABASE_URL } from '$app/env/private';

let pool: pg.Pool | undefined;

/**
 * The shop's Postgres pool, opened on first use: `vite build` imports server
 * modules to analyse the app, and there is no database then.
 */
export function db(): pg.Pool {
	pool ??= new pg.Pool({ connectionString: DATABASE_URL });
	return pool;
}

const catalog = [
	['Facet', '7.00', 'facet'],
	['Bezel', '12.00', 'bezel'],
	['Hinge', '4.00', 'hinge'],
	['Latch', '9.00', 'latch'],
	['Knob', '3.00', 'knob']
];

/** Creates the shop's tables and its catalog when they are missing. Runs at startup. */
export async function createTables(): Promise<void> {
	await db().query(`
		CREATE TABLE IF NOT EXISTS products (
			id SERIAL PRIMARY KEY,
			name TEXT NOT NULL,
			price TEXT NOT NULL,
			sku TEXT NOT NULL UNIQUE
		);
		CREATE TABLE IF NOT EXISTS users (
			id TEXT PRIMARY KEY,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE TABLE IF NOT EXISTS orders (
			id SERIAL PRIMARY KEY,
			user_id TEXT NOT NULL REFERENCES users (id),
			product_name TEXT NOT NULL,
			amount TEXT NOT NULL,
			currency TEXT NOT NULL,
			status TEXT NOT NULL
		);
	`);
	for (const [name, price, sku] of catalog) {
		await db().query(
			'INSERT INTO products (name, price, sku) SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = $3)',
			[name, price, sku]
		);
	}
}
