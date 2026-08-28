/**
 * The shop's own wire shapes, and the small pure helpers every stack's UI
 * needs to render them.
 *
 * snake_case, because these are a TRANSCRIPT of what the server sent — the
 * same rule the OpenReceive packages follow. Do not "fix" the casing: keeping
 * these literal is what turns a payload mismatch into a type error instead of
 * an `undefined` at runtime, and with four stacks serving the same shapes it
 * is the contract that keeps them in step. The translation to camelCase
 * happens exactly once, at the store boundary.
 *
 * This module imports NOTHING but the standard library. It is the one file
 * every stack shares — React hosts, the no-framework host, and the Node
 * servers — so it must stay free of React, of Node, and of any package that is
 * not already a dependency everywhere.
 */

// ---------------------------------------------------------------- the catalog

export type ShopCatalogEntry = {
  sku: string;
  name: string;
  price_cents: number;
  /** Digested, and built by the server: the browser could not derive it. */
  image_url: string;
};

/**
 * Who this browser is, as far as the shop is concerned.
 *
 * `public_ref` is the visitor's PUBLIC uuid — the one the recent-orders feed
 * attributes rows to. The private id lives in a signed cookie and never
 * reaches the browser as a value. The SPA compares this against each feed row
 * to draw its own "You" badge, which is what lets the feed stay one public,
 * identical-for-everyone, cacheable response.
 */
export type ShopVisitor = {
  public_ref: string;
};

export type ShopBootstrap = {
  currency: string;
  max_per_sku: number;
  openreceive_prefix: string;
  catalog: ShopCatalogEntry[];
  visitor: ShopVisitor | null;
};

// ---------------------------------------------------------- the private order

export type ShopOrderItemPayload = {
  sku: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  /** Present only once the order is paid. A live download URL — never public. */
  download_path: string | null;
};

export type ShopOrderPayload = {
  reference: string;
  state: string;
  currency: string;
  total_cents: number;
  total_amount: string;
  description: string;
  paid_at: number | null;
  items: ShopOrderItemPayload[];
};

// ------------------------------------------------------------- the public feed

/**
 * One line on a public feed row.
 *
 * Deliberately shows what was bought. The six prices are public and distinct,
 * so a $1.00 row is a Safety Orange with certainty — hiding the item while
 * showing the amount is not anonymity, it is the appearance of it.
 */
export type ShopFeedItem = {
  sku: string;
  name: string;
  quantity: number;
  image_url: string | null;
};

/**
 * A paid order, as everyone sees it.
 *
 * There is no order id here, not even truncated: `shop_orders.id` IS the
 * OpenReceive reference, the key `checkout.prepare` and `checkout.create` are
 * called with. It has no business in a public payload. Rows key on their index.
 */
export type ShopFeedOrder = {
  buyer: string | null;
  total_cents: number;
  total_amount: string;
  currency: string;
  /** Unix SECONDS. Not milliseconds — one conversion, at the edge. */
  paid_at: number | null;
  items: ShopFeedItem[];
};

export type ShopFeedTotals = {
  paid_orders: number;
  buttons_sold: number;
};

export type ShopFeed = {
  orders: ShopFeedOrder[];
  totals: ShopFeedTotals;
};

// ------------------------------------------------------------------ the routes

/**
 * The Node hosts serve the bootstrap payload as a route and the SPA fetches it
 * on mount. Rails inlines the identical payload into its ERB layout instead —
 * that is the one thing the four stacks genuinely do differently, and it is why
 * this path is a shared constant rather than a string in three clients.
 */
export const SHOP_BOOTSTRAP_PATH = "/shop/bootstrap";

export const SHOP_ORDERS_PATH = "/shop/orders";
export const SHOP_FEED_PATH = "/shop/recent_orders";

export const shopOrderPath = (reference: string): string =>
  `${SHOP_ORDERS_PATH}/${encodeURIComponent(reference)}`;

// ------------------------------------------------------------------ formatting

/** Integer cents in, a display string out. The only place a division happens. */
export const formatUsdCents = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

/**
 * "Safety Orange ×2, Classic Black" — the same sentence the server builds for
 * `amount_for`'s `description`, rebuilt here for feed rows, which carry items
 * rather than a prose summary.
 */
export const summarizeItems = (items: readonly ShopFeedItem[]): string =>
  items
    .map((item) => (item.quantity > 1 ? `${item.name} ×${item.quantity}` : item.name))
    .join(", ");

/** "1 order", "2 orders". A visible "1 orders" in the footer is a bug. */
export const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "just now" / "4m ago" / "3h ago" / "2d ago", from unix SECONDS.
 *
 * Coarse on purpose: the feed refreshes every thirty seconds and a live-ticking
 * second count would redraw every row for no information. A null stamp reads as
 * empty rather than "54 years ago".
 */
export const relativeTime = (paidAtSeconds: number | null, nowMs = Date.now()): string => {
  if (!paidAtSeconds) return "";
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - paidAtSeconds);
  if (seconds < MINUTE) return "just now";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m ago`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h ago`;
  return `${Math.floor(seconds / DAY)}d ago`;
};
