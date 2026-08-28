/**
 * The shop's own persistence, on `node:sqlite`. One implementation serves all
 * three Node stacks, exactly as the Rails models serve that one.
 *
 * THE DATABASE SURVIVES A RESTART. Hello Fruit wiped its file on every boot,
 * which is honest for a disposable checkout surface and wrong for a demo whose
 * whole subject is persistence: orders, users and products outlive the
 * process. That is the demo.
 *
 * OpenReceive never sees anything in this file. The three hooks in
 * openreceive-config.ts are the only bridge:
 *   authorize   -> shop_user_id vs. the signed cookie
 *   amountFor   -> orderAmount / checkoutDescription, below
 *   onPaid      -> claimShopOrderPaid, below
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { migrations } from "./migrations.ts";

// A cart is a few buttons, not a wholesale order.
export const MAX_PER_SKU = 10;

// How many rows the public feed shows, and the only limit it honours.
export const FEED_LIMIT = 25;

export const AWAITING_PAYMENT = "awaiting_payment";
export const PAID = "paid";

// Hex digits spelled out: Ruby's `\h` has no JavaScript equivalent, and `\h`
// in a JS regex silently means the letter "h".
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU_PATTERN = /^[a-z]+(?:-[a-z]+)*$/;

// How long a row may go untouched before `touchSeen` writes again. A page load
// is a dozen requests and remembering "last seen" must not be a write storm.
const SEEN_THROTTLE_SECONDS = 5 * 60;

const BUTTONS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The one copy of the artwork. Four stacks read this directory; nobody copies the files. */
export const ARTWORK_DIR = path.join(BUTTONS_ROOT, "images");

export const unixNow = (): number => Math.floor(Date.now() / 1_000);

/**
 * The reference arrives as a string the payer's browser sent. Postgres RAISES
 * on a malformed uuid literal; SQLite would happily compare it and return
 * nothing. The check stays in both stacks anyway — it is the same trust
 * boundary, described the same way in the docs, and this demo is copied from.
 */
export const isReference = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

/** A decimal string, never a float. The division happens once, here, at the edge. */
export const formatAmount = (cents: number): string => (cents / 100).toFixed(2);

export interface ShopProductRow {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly price_cents: number;
  readonly position: number;
  readonly image_name: string;
  readonly active: number;
}

export interface ShopUserRow {
  readonly id: string;
  readonly public_ref: string;
  readonly first_seen_at: number;
  readonly last_seen_at: number;
}

export interface ShopOrderRow {
  readonly id: string;
  readonly shop_user_id: string;
  readonly state: string;
  readonly total_cents: number;
  readonly currency: string;
  readonly paid_at: number | null;
  readonly payment_hash: string | null;
  readonly created_at: number;
}

export interface ShopOrderItemRow {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly unit_price_cents: number;
  readonly quantity: number;
  /** From the product row when it still exists; null once the product is gone. */
  readonly image_name: string | null;
}

/** An order and its items, which is the only shape anything downstream wants. */
export interface ShopOrderRecord {
  readonly order: ShopOrderRow;
  readonly items: readonly ShopOrderItemRow[];
}

/** A paid order plus the buyer's PUBLIC handle. The private id never leaves the store. */
export interface ShopFeedRecord extends ShopOrderRecord {
  readonly buyer: string | null;
}

/** One priced line, resolved against the live catalog. Never a number off the wire. */
export interface ShopOrderLine {
  readonly product: ShopProductRow;
  readonly quantity: number;
}

/**
 * Statements run against the shop's own tables.
 *
 * Async and row-returning because the settlement hook's `query` is: inside
 * `onPaid` the guarded transition has to run in OpenReceive's transaction, not
 * on a second connection, and that is the only interface it offers. The
 * store's own implementation of the same shape is what tests and non-settlement
 * callers use.
 */
export type RunQuery = (
  sql: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

export interface OpenShopStoreOptions {
  /** Names the database file, so two stacks on one machine are two shops. */
  readonly demoId: string;
  readonly log?: (event: string, message: string, fields?: Record<string, unknown>) => void;
}

export interface ShopStore {
  readonly db: DatabaseSync;
  readonly path: string;
  /** The data directory. The cookie secret is kept beside the database. */
  readonly dir: string;
  /** The shop's own tables, through the same interface `onPaid` hands out. */
  readonly query: RunQuery;
  close(): void;

  activeCatalog(): readonly ShopProductRow[];
  activeProductBySku(sku: unknown): ShopProductRow | null;

  createUser(): ShopUserRow;
  userById(id: unknown): ShopUserRow | null;
  touchSeen(user: ShopUserRow): void;

  createOrder(lines: readonly ShopOrderLine[], shopUserId: string): ShopOrderRecord;
  orderByReference(reference: unknown): ShopOrderRecord | null;

  recentOrders(limit: number): readonly ShopFeedRecord[];
  feedTotals(): { readonly paid_orders: number; readonly buttons_sold: number };
}

/**
 * Where the demo SQLite files live. `OPENRECEIVE_DEMO_DB` (a directory path)
 * overrides the in-repo default so hermetic runs — the E2E harness — point the
 * store at a temp dir instead of examples/buttons/.data.
 */
const databaseDir = (): string => {
  const override = process.env.OPENRECEIVE_DEMO_DB;
  if (override !== undefined && override.length > 0) return path.resolve(override);
  return path.join(BUTTONS_ROOT, ".data");
};

export const openShopStore = (options: OpenShopStoreOptions): ShopStore => {
  const log = options.log ?? (() => undefined);
  const dir = databaseDir();
  mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, `${options.demoId}.sqlite`);

  const db = new DatabaseSync(dbPath);
  // Off by default, and a missing foreign key is silent.
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");

  const applied = migrate(db);
  log("shop.store.ready", "Shop SQLite store is ready.", {
    path: dbPath,
    migrationsApplied: applied,
  });

  const query: RunQuery = async (sql, params) =>
    db.prepare(sql).all(...(params as never[])) as readonly Record<string, unknown>[];

  const selectItems = db.prepare(`
    SELECT i.id, i.sku, i.name, i.unit_price_cents, i.quantity, p.image_name AS image_name
      FROM shop_order_items i
      LEFT JOIN shop_products p ON p.id = i.product_id
     WHERE i.shop_order_id = ?
     ORDER BY i.created_at, i.rowid
  `);

  const readItems = (orderId: string): readonly ShopOrderItemRow[] =>
    selectItems.all(orderId) as unknown as readonly ShopOrderItemRow[];

  return {
    db,
    path: dbPath,
    dir,
    query,

    close: () => db.close(),

    // Read FRESH on every order creation. Do NOT memoize this at module level:
    // reading it live is the entire point of moving prices out of code and into
    // a table an operator can edit.
    activeCatalog: () =>
      db
        .prepare(
          `SELECT id, sku, name, price_cents, position, image_name, active
             FROM shop_products WHERE active = 1 ORDER BY position, price_cents`,
        )
        .all() as unknown as readonly ShopProductRow[],

    // `active = 0` hides a product from the catalog and from order creation. It
    // must NOT break an existing order's receipt, its download, or its feed row
    // — that is what the snapshots on shop_order_items are for.
    activeProductBySku: (sku) => {
      if (typeof sku !== "string" || !SKU_PATTERN.test(sku)) return null;
      const row = db
        .prepare(
          `SELECT id, sku, name, price_cents, position, image_name, active
             FROM shop_products WHERE active = 1 AND sku = ?`,
        )
        .get(sku) as unknown as ShopProductRow | undefined;
      return row ?? null;
    },

    createUser: () => {
      const now = unixNow();
      // TWO UUIDS, ON PURPOSE. `id` is the ownership token that travels in the
      // signed cookie and is never rendered; `public_ref` is the handle the
      // feed shows. Not because publishing `id` would be exploitable — the
      // cookie is signed — but because a published `id` stops being safe the
      // moment anything else accepts a bare uuid.
      const user: ShopUserRow = {
        id: randomUUID(),
        public_ref: randomUUID(),
        first_seen_at: now,
        last_seen_at: now,
      };
      db.prepare(
        `INSERT INTO shop_users
           (id, public_ref, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(user.id, user.public_ref, now, now, now, now);
      return user;
    },

    // A cookie that outlives its row must degrade to a NEW visitor, not to a
    // 500 on the home page — so this returns null rather than throwing.
    userById: (id) => {
      if (!isReference(id)) return null;
      const row = db
        .prepare(`SELECT id, public_ref, first_seen_at, last_seen_at FROM shop_users WHERE id = ?`)
        .get(id) as unknown as ShopUserRow | undefined;
      return row ?? null;
    },

    touchSeen: (user) => {
      const now = unixNow();
      if (now - user.last_seen_at < SEEN_THROTTLE_SECONDS) return;
      db.prepare(`UPDATE shop_users SET last_seen_at = ? WHERE id = ?`).run(now, user.id);
    },

    // One transaction: the order and every item, with the total summed from the
    // PRODUCT rows the handler looked up. Nothing here reads a number the
    // browser sent.
    //
    // The name and unit price are copied onto the item deliberately: an item row
    // must stay readable after its product is gone, and renaming a product must
    // not retroactively rewrite what somebody bought last week.
    createOrder: (lines, shopUserId) => {
      const now = unixNow();
      const id = randomUUID();
      const totalCents = lines.reduce(
        (total, line) => total + line.product.price_cents * line.quantity,
        0,
      );

      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO shop_orders
             (id, shop_user_id, state, total_cents, currency, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'USD', ?, ?)`,
        ).run(id, shopUserId, AWAITING_PAYMENT, totalCents, now, now);

        const insertItem = db.prepare(
          `INSERT INTO shop_order_items
             (id, shop_order_id, product_id, sku, name, unit_price_cents, quantity,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const line of lines) {
          insertItem.run(
            randomUUID(),
            id,
            line.product.id,
            line.product.sku,
            line.product.name,
            line.product.price_cents,
            line.quantity,
            now,
            now,
          );
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }

      return {
        order: {
          id,
          shop_user_id: shopUserId,
          state: AWAITING_PAYMENT,
          total_cents: totalCents,
          currency: "USD",
          paid_at: null,
          payment_hash: null,
          created_at: now,
        },
        items: readItems(id),
      };
    },

    orderByReference: (reference) => {
      if (!isReference(reference)) return null;
      const order = db
        .prepare(
          `SELECT id, shop_user_id, state, total_cents, currency, paid_at, payment_hash, created_at
             FROM shop_orders WHERE id = ?`,
        )
        .get(reference) as unknown as ShopOrderRow | undefined;
      if (order === undefined) return null;
      return { order, items: readItems(order.id) };
    },

    // Paid rows, newest first, with buyers and items preloaded — the feed is an
    // N+1 by default and this is a demo people read. Two queries, joined here.
    recentOrders: (limit) => {
      const orders = db
        .prepare(
          `SELECT o.id, o.shop_user_id, o.state, o.total_cents, o.currency, o.paid_at,
                  o.payment_hash, o.created_at, u.public_ref AS buyer
             FROM shop_orders o
             LEFT JOIN shop_users u ON u.id = o.shop_user_id
            WHERE o.state = ?
            ORDER BY o.paid_at DESC, o.created_at DESC
            LIMIT ?`,
        )
        .all(PAID, limit) as unknown as readonly (ShopOrderRow & { buyer: string | null })[];

      return orders.map(({ buyer, ...order }) => ({
        order,
        buyer,
        items: readItems(order.id),
      }));
    },

    feedTotals: () => {
      const paidOrders = db
        .prepare(`SELECT COUNT(*) AS n FROM shop_orders WHERE state = ?`)
        .get(PAID) as unknown as { n: number };
      const sold = db
        .prepare(
          `SELECT COALESCE(SUM(i.quantity), 0) AS n
             FROM shop_order_items i
             JOIN shop_orders o ON o.id = i.shop_order_id
            WHERE o.state = ?`,
        )
        .get(PAID) as unknown as { n: number };
      return { paid_orders: Number(paidOrders.n), buttons_sold: Number(sold.n) };
    },
  };
};

/**
 * The migration runner, whole. Read the list, skip what `schema_migrations`
 * already names, apply the rest, each inside its own transaction so a failure
 * leaves the previous step committed and this one absent.
 */
const migrate = (db: DatabaseSync): number => {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const done = new Set(
    (db.prepare(`SELECT version FROM schema_migrations`).all() as { version: string }[]).map(
      (row) => row.version,
    ),
  );

  let applied = 0;
  for (const migration of migrations) {
    if (done.has(migration.id)) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      migration.run(db);
      db.prepare(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`).run(
        migration.id,
        unixNow(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    applied += 1;
  }
  return applied;
};

/**
 * THE GUARDED TRANSITION, idempotent by construction: the WHERE clause is the
 * lock. Whoever flips awaiting_payment -> paid first is the only one who
 * fulfills; a later attempt updates zero rows and does nothing. Returns true
 * when THIS call is the one that claimed the order.
 *
 * `RETURNING id` rather than a driver-specific `changes` count, because the
 * caller that matters runs through the settlement hook's `query`, and rows are
 * the only thing that interface gives back.
 *
 * OpenReceive already guarantees its settlement hook runs at most once per
 * reference across every path it owns. This is still written this way because
 * OpenReceive cannot see a second fulfillment path of OURS — an admin action, a
 * support tool, a replayed job — and the moment one exists, those race each
 * other rather than the library.
 */
export const claimShopOrderPaid = async (input: {
  readonly reference: unknown;
  readonly paidAt: number;
  readonly paymentHash: string;
  readonly query: RunQuery;
}): Promise<boolean> => {
  if (!isReference(input.reference)) return false;
  const rows = await input.query(
    `UPDATE shop_orders
        SET state = 'paid', paid_at = ?, payment_hash = ?, updated_at = ?
      WHERE id = ? AND state = 'awaiting_payment'
      RETURNING id`,
    [input.paidAt, input.paymentHash, unixNow(), input.reference],
  );
  return rows.length > 0;
};

export const isPaid = (record: ShopOrderRecord): boolean => record.order.state === PAID;

/**
 * What the payer is BUYING, in our own words — one display string rendered
 * above the amount on every checkout screen. Without it the payer sees a QR
 * code and "$4.00" and no sign of what the four dollars is for, because
 * OpenReceive owns no line items and can show nothing else on its own.
 *
 * Built from the item SNAPSHOTS, so it reads the same after a catalog edit.
 */
export const checkoutDescription = (record: ShopOrderRecord): string => {
  const parts = record.items.map((item) =>
    item.quantity > 1 ? `${item.name || item.sku} ×${item.quantity}` : item.name || item.sku,
  );
  const count = record.items.reduce((total, item) => total + item.quantity, 0);
  return `OpenReceive ${count === 1 ? "button" : "buttons"}: ${parts.join(", ")}`;
};

/**
 * THE TRUST BOUNDARY, and it exists ONCE. The cart is a list of claims: only
 * the sku and the quantity survive, each sku is looked up in the live active
 * catalog, and the price comes from that row and never from the request.
 *
 * An unknown or deactivated sku is DROPPED rather than rejecting the whole
 * request, quantities are coerced and clamped, duplicate lines are merged, and
 * the result is re-emitted in catalog order.
 */
export const normalizedLines = (requested: unknown, store: ShopStore): readonly ShopOrderLine[] => {
  if (!Array.isArray(requested)) return [];

  const quantities = new Map<string, { product: ShopProductRow; quantity: number }>();
  for (const line of requested) {
    if (typeof line !== "object" || line === null) continue;
    const claim = line as { sku?: unknown; quantity?: unknown };
    const product = store.activeProductBySku(claim.sku);
    if (product === null) continue;

    const quantity = Math.trunc(Number(claim.quantity));
    if (!Number.isFinite(quantity) || quantity <= 0) continue;

    const existing = quantities.get(product.id);
    quantities.set(product.id, {
      product,
      quantity: Math.min((existing?.quantity ?? 0) + quantity, MAX_PER_SKU),
    });
  }

  if (quantities.size === 0) return [];

  return store
    .activeCatalog()
    .map((product) => quantities.get(product.id))
    .filter((line): line is ShopOrderLine => line !== undefined && line.quantity > 0);
};
