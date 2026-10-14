import { randomUUID } from 'node:crypto';
import { db } from './db.ts';

export interface Product {
	id: number;
	name: string;
	/** A decimal string, e.g. "7.00". */
	price: string;
}

export interface Order {
	id: number;
	product_name: string;
	/** A decimal string, copied from the product when the order is placed. */
	amount: string;
	currency: string;
	status: 'awaiting_payment' | 'paid';
}

/** A row id from a form field or a URL, or undefined when it cannot be one. */
function rowId(value: unknown): number | undefined {
	const id = Number(value);
	return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : undefined;
}

export async function listProducts(): Promise<Product[]> {
	const { rows } = await db().query<Product>('SELECT id, name, price FROM products ORDER BY id');
	return rows;
}

export async function findProduct(id: unknown): Promise<Product | undefined> {
	const productId = rowId(id);
	if (productId === undefined) return undefined;
	const { rows } = await db().query<Product>('SELECT id, name, price FROM products WHERE id = $1', [
		productId
	]);
	return rows[0];
}

export async function userExists(id: string): Promise<boolean> {
	const { rowCount } = await db().query('SELECT 1 FROM users WHERE id = $1', [id]);
	return rowCount === 1;
}

export async function createUser(): Promise<string> {
	const id = randomUUID();
	await db().query('INSERT INTO users (id) VALUES ($1)', [id]);
	return id;
}

/** Copies the product's current price into a new order. */
export async function createOrder(userId: string, product: Product): Promise<number> {
	const { rows } = await db().query<{ id: number }>(
		`INSERT INTO orders (user_id, product_name, amount, currency, status)
		 VALUES ($1, $2, $3, 'USD', 'awaiting_payment') RETURNING id`,
		[userId, product.name, product.price]
	);
	return rows[0].id;
}

/** The order, only when this user placed it. */
export async function findOrder(id: unknown, userId: string): Promise<Order | undefined> {
	const orderId = rowId(id);
	if (orderId === undefined) return undefined;
	const { rows } = await db().query<Order>(
		'SELECT id, product_name, amount, currency, status FROM orders WHERE id = $1 AND user_id = $2',
		[orderId, userId]
	);
	return rows[0];
}
