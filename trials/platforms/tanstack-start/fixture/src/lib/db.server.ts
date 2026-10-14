import pg from 'pg'

// The catalog the shop opens with, in this order.
const catalog = [
  ['Facet', '7.00', 'facet'],
  ['Bezel', '12.00', 'bezel'],
  ['Hinge', '4.00', 'hinge'],
  ['Latch', '9.00', 'latch'],
  ['Knob', '3.00', 'knob'],
]

let ready: Promise<pg.Pool> | undefined

/**
 * The shop's Postgres pool. The first call opens it from DATABASE_URL and
 * creates the tables and the catalog when they are missing.
 */
export function db(): Promise<pg.Pool> {
  ready ??= open().catch((error: unknown) => {
    ready = undefined
    throw error
  })
  return ready
}

async function open(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  try {
    await createTables(pool)
  } catch (error) {
    await pool.end()
    throw error
  }
  return pool
}

async function createTables(pool: pg.Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Two servers starting at once take turns.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('widget-shop-schema'))")
    await client.query(`
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
        user_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        amount TEXT NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `)
    for (const [name, price, sku] of catalog) {
      await client.query(
        `INSERT INTO products (name, price, sku)
         SELECT $1::text, $2::text, $3::text
         WHERE NOT EXISTS (SELECT 1 FROM products WHERE sku = $3::text)`,
        [name, price, sku],
      )
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
