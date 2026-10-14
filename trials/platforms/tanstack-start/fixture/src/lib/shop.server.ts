import { randomUUID } from 'node:crypto'
import { getCookie, setCookie } from '@tanstack/react-start/server'
import { db } from './db.server'

export interface Product {
  id: number
  name: string
  /** A decimal string, e.g. "7.00". */
  price: string
}

export interface Order {
  id: number
  product_name: string
  amount: string
  currency: string
  status: string
}

/** The browser's customer: a users row id, kept in this cookie. */
const USER_COOKIE = 'widget_user'

/** Ids are Postgres integers: anything else matches no row. */
function isId(id: number): boolean {
  return Number.isInteger(id) && id > 0 && id <= 2147483647
}

export async function listProducts(): Promise<Product[]> {
  const pool = await db()
  const { rows } = await pool.query<Product>('SELECT id, name, price FROM products ORDER BY id')
  return rows
}

export async function findProduct(id: number): Promise<Product | undefined> {
  if (!isId(id)) return undefined
  const pool = await db()
  const { rows } = await pool.query<Product>('SELECT id, name, price FROM products WHERE id = $1', [id])
  return rows[0]
}

/** The customer this request's cookie names, when that user exists. */
export async function currentUserId(): Promise<string | undefined> {
  const id = getCookie(USER_COOKIE)
  if (!id) return undefined
  const pool = await db()
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM users WHERE id = $1', [id])
  return rows[0]?.id
}

/** A new customer, remembered in this browser's cookie. */
export async function createUser(): Promise<string> {
  const id = randomUUID()
  const pool = await db()
  await pool.query('INSERT INTO users (id) VALUES ($1)', [id])
  // Plain http in Docker, so not `secure`.
  setCookie(USER_COOKIE, id, { httpOnly: true, path: '/', sameSite: 'lax' })
  return id
}

/** A new order, with the product's current price copied onto it. */
export async function createOrder(userId: string, product: Product): Promise<number> {
  const pool = await db()
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO orders (user_id, product_name, amount, currency, status)
     VALUES ($1, $2, $3, 'USD', 'awaiting_payment')
     RETURNING id`,
    [userId, product.name, product.price],
  )
  return rows[0].id
}

/** The order, only for the customer who placed it. */
export async function findOrder(id: number, userId: string): Promise<Order | undefined> {
  if (!isId(id)) return undefined
  const pool = await db()
  const { rows } = await pool.query<Order>(
    'SELECT id, product_name, amount, currency, status FROM orders WHERE id = $1 AND user_id = $2',
    [id, userId],
  )
  return rows[0]
}

/** The order, only when this request's cookie belongs to the customer who placed it. */
export async function findOwnOrder(id: number): Promise<Order | undefined> {
  const userId = getCookie(USER_COOKIE)
  return userId ? findOrder(id, userId) : undefined
}
