export interface Product {
  id: number;
  name: string;
  price: string;
}

export interface Order {
  id: number;
  product_name: string;
  amount: string;
  currency: string;
  status: string;
}

/** A Postgres `integer` key: anything else matches no row. */
function isRowId(id: number): boolean {
  return Number.isInteger(id) && id > 0 && id <= 2_147_483_647;
}

export async function listProducts(): Promise<Product[]> {
  const db = await useShopDb();
  const { rows } = await db.query<Product>("SELECT id, name, price FROM products ORDER BY id");
  return rows;
}

export async function findProduct(id: number): Promise<Product | undefined> {
  if (!isRowId(id)) return undefined;
  const db = await useShopDb();
  const { rows } = await db.query<Product>("SELECT id, name, price FROM products WHERE id = $1", [id]);
  return rows[0];
}

export async function userExists(id: string): Promise<boolean> {
  const db = await useShopDb();
  const { rowCount } = await db.query("SELECT 1 FROM users WHERE id = $1", [id]);
  return rowCount === 1;
}

export async function createUser(id: string): Promise<void> {
  const db = await useShopDb();
  await db.query("INSERT INTO users (id) VALUES ($1)", [id]);
}

/** Copies the product's current price into a new order. */
export async function createOrder(userId: string, product: Product): Promise<number> {
  const db = await useShopDb();
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO orders (user_id, product_name, amount, currency, status)
     VALUES ($1, $2, $3, 'USD', 'awaiting_payment')
     RETURNING id`,
    [userId, product.name, product.price],
  );
  return rows[0]!.id;
}

/** The order, only when this user placed it. */
export async function findOrder(id: number, userId: string): Promise<Order | undefined> {
  if (!isRowId(id)) return undefined;
  const db = await useShopDb();
  const { rows } = await db.query<Order>(
    "SELECT id, product_name, amount, currency, status FROM orders WHERE id = $1 AND user_id = $2",
    [id, userId],
  );
  return rows[0];
}
