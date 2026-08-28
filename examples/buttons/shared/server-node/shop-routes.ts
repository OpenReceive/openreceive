/**
 * The shop's five handlers, framework-free.
 *
 * Plain functions of (request-ish, context), returning a plain result, so
 * Express and the Next.js app router can both mount them without either one
 * owning the logic. None of them re-implements `normalizedLines` — that
 * function is the trust boundary and it exists once, in store.ts.
 *
 * OpenReceive owns none of this. It never sees an order, a cart, a price, a
 * product or a download; the SPA talks to these routes for everything except
 * the payment itself, which goes to the mounted engine.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import type { ShopBootstrap, ShopFeed, ShopFeedOrder, ShopOrderPayload } from "../shop-types.ts";
import {
  parseCookieHeader,
  readSignedCookieValue,
  serializeIdentityCookie,
  SHOP_COOKIE,
} from "./cookie.ts";
import {
  ARTWORK_DIR,
  checkoutDescription,
  FEED_LIMIT,
  formatAmount,
  isPaid,
  MAX_PER_SKU,
  normalizedLines,
  type ShopOrderRecord,
  type ShopStore,
  type ShopUserRow,
} from "./store.ts";

/** Everything a handler needs that is not the request. */
export interface ShopContext {
  readonly store: ShopStore;
  /** Signs the identity cookie. See cookie.ts for where it comes from. */
  readonly secret: string;
  /** Where the engine is mounted. The SPA hydrates it rather than hard-coding it. */
  readonly openreceivePrefix: string;
}

export interface ShopRequest {
  readonly cookieHeader: string | undefined;
  /** Parsed JSON body, on `createOrder` only. */
  readonly body?: unknown;
  readonly params?: Record<string, string | undefined>;
  /** Whether this request arrived over TLS. Decides the cookie's Secure flag. */
  readonly secure: boolean;
}

export interface ShopFileResult {
  readonly path: string;
  readonly filename: string;
  readonly contentType: string;
}

export interface ShopResult {
  readonly status: number;
  readonly json?: unknown;
  readonly file?: ShopFileResult;
  readonly headers?: Record<string, string>;
  /** A Set-Cookie line the adapter writes verbatim. */
  readonly setCookie?: string;
}

export const SHOP_IMAGES_PREFIX = "/images";

/** Where the artwork is mounted, and the one directory every stack reads. */
export const shopArtworkDir = ARTWORK_DIR;

const imageUrl = (imageName: string | null): string | null =>
  imageName === null ? null : `${SHOP_IMAGES_PREFIX}/${encodeURIComponent(imageName)}`;

const downloadPath = (reference: string, sku: string): string =>
  `/shop/orders/${encodeURIComponent(reference)}/downloads/${encodeURIComponent(sku)}`;

/**
 * The visitor, minting a row the first time this browser is seen.
 *
 * Called from the SHOP handlers only — never from a health check, an asset or
 * the public feed. A demo that mints a user row for every crawler hit is a
 * junk-row generator, and the row is only meaningful on a route that can place
 * an order.
 */
export const resolveVisitor = (
  request: ShopRequest,
  context: ShopContext,
): { readonly user: ShopUserRow; readonly setCookie: string } => {
  const signed = parseCookieHeader(request.cookieHeader)[SHOP_COOKIE];
  const id = readSignedCookieValue(signed, context.secret);
  // A cookie that outlives its row, or one that fails the signature, degrades
  // to a NEW visitor rather than to a 500.
  const user = (id === undefined ? null : context.store.userById(id)) ?? context.store.createUser();
  context.store.touchSeen(user);

  return {
    user,
    setCookie: serializeIdentityCookie({
      value: user.id,
      secret: context.secret,
      secure: request.secure,
    }),
  };
};

/**
 * The visitor's private id, WITHOUT minting one. This is what `authorize`
 * reads: an engine request that carries no valid cookie is a 403, not a new
 * customer.
 */
export const visitorIdFrom = (
  cookieHeader: string | undefined,
  secret: string,
): string | undefined =>
  readSignedCookieValue(parseCookieHeader(cookieHeader)[SHOP_COOKIE], secret);

/**
 * Possession of an order id is a CLAIM, not proof — the same rule the engine's
 * `authorize` applies. Another visitor's order is 404 and never 403: do not
 * confirm that an id exists.
 */
const authorizedOrder = (
  reference: unknown,
  user: ShopUserRow,
  store: ShopStore,
): ShopOrderRecord | null => {
  const record = store.orderByReference(reference);
  if (record === null || record.order.shop_user_id !== user.id) return null;
  return record;
};

// ------------------------------------------------------------------ bootstrap

/**
 * What the SPA hydrates from: the catalog with its image urls, the engine
 * mount prefix, and this visitor's PUBLIC uuid.
 *
 * The Rails host inlines this same payload into its ERB layout instead, which
 * is the one thing the four stacks genuinely do differently. Everything the
 * client does with it is shared.
 */
export const bootstrap = (request: ShopRequest, context: ShopContext): ShopResult => {
  const { user, setCookie } = resolveVisitor(request, context);

  const payload: ShopBootstrap = {
    currency: "USD",
    max_per_sku: MAX_PER_SKU,
    openreceive_prefix: context.openreceivePrefix,
    // The catalog ships FROM THE SERVER because the prices are ours: the
    // browser must not be allowed to supply either a price or an image url.
    catalog: context.store.activeCatalog().map((product) => ({
      sku: product.sku,
      name: product.name,
      price_cents: product.price_cents,
      image_url: imageUrl(product.image_name) ?? "",
    })),
    // The public handle only. The private id stays in the signed cookie.
    visitor: { public_ref: user.public_ref },
  };

  return {
    status: 200,
    json: { shop: payload },
    setCookie,
    // Names this visitor. It must never be cached by anything.
    headers: { "Cache-Control": "no-store" },
  };
};

// --------------------------------------------------------------- create order

/**
 * One cart becomes one order becomes one reference.
 *
 * The reference has to exist BEFORE checkout and survive every retry, so it is
 * minted here, once, and the browser holds it. A fresh id per attempt would
 * leave one cart payable twice.
 */
export const createOrder = (request: ShopRequest, context: ShopContext): ShopResult => {
  const { user, setCookie } = resolveVisitor(request, context);

  const body = request.body as { items?: unknown } | undefined;
  const lines = normalizedLines(body?.items, context.store);
  if (lines.length === 0) {
    return { status: 422, json: { error: "Your cart is empty." }, setCookie };
  }

  const record = context.store.createOrder(lines, user.id);
  return { status: 201, json: orderPayload(record), setCookie };
};

// ----------------------------------------------------------------- show order

/**
 * The order as THIS browser is allowed to see it. The SPA polls this after
 * settlement to learn the downloads have unlocked; `state` flips only in
 * `onPaid`.
 */
export const showOrder = (request: ShopRequest, context: ShopContext): ShopResult => {
  const { user, setCookie } = resolveVisitor(request, context);
  const record = authorizedOrder(request.params?.reference, user, context.store);
  if (record === null) return { status: 404, json: { error: "Not found." }, setCookie };

  return {
    status: 200,
    json: orderPayload(record),
    setCookie,
    headers: { "Cache-Control": "no-store" },
  };
};

// ------------------------------------------------------------------- download

/**
 * The thing that was bought.
 *
 * Fulfillment is gated on the ORDER ROW, not on anything the browser says:
 * `paid` is written inside OpenReceive's settlement transaction and nowhere
 * else. This deliberately does NOT go through the static artwork mount.
 */
export const download = (request: ShopRequest, context: ShopContext): ShopResult => {
  const { user, setCookie } = resolveVisitor(request, context);
  const record = authorizedOrder(request.params?.reference, user, context.store);
  if (record === null) return { status: 404, json: { error: "Not found." }, setCookie };
  if (!isPaid(record)) return { status: 403, json: { error: "Not paid." }, setCookie };

  const sku = request.params?.sku;
  const item = record.items.find((candidate) => candidate.sku === sku);
  if (item === undefined) return { status: 404, json: { error: "Not found." }, setCookie };

  // The snapshot names the sku; the file name comes from the product row when
  // it still exists and from the sku convention when it does not — a
  // deactivated or deleted product must not break a download somebody paid for.
  const imageName = item.image_name ?? `openreceive-${item.sku}-button.webp`;
  // `basename` because the name reaches here from a database column, and a
  // column is only as trustworthy as whoever last edited it: a value with a
  // path separator must not be able to walk out of the artwork directory.
  const filePath = path.join(ARTWORK_DIR, path.basename(imageName));
  if (!existsSync(filePath)) return { status: 404, json: { error: "Not found." }, setCookie };

  return {
    status: 200,
    setCookie,
    file: { path: filePath, filename: path.basename(imageName), contentType: "image/webp" },
  };
};

// --------------------------------------------------------------- recent orders

/**
 * Public, unauthenticated, paid orders only.
 *
 * NO VISITOR IS MINTED HERE. This is the one shop route a crawler can hit
 * without intending to shop, and it is also the route that must stay one
 * identical, cacheable response for everybody.
 *
 * Paid-only is also the anti-spam design: anyone can POST an order as many
 * times as they like, and a feed that showed unpaid ones would be a free
 * billboard. An entry here costs a real payment.
 */
export const recentOrders = (_request: ShopRequest, context: ShopContext): ShopResult => {
  // A larger ?limit= is IGNORED — not honoured, not rejected.
  const orders = context.store.recentOrders(FEED_LIMIT);
  const feed: ShopFeed = {
    orders: orders.map((record) => feedPayload(record, record.buyer)),
    totals: context.store.feedTotals(),
  };

  return {
    status: 200,
    json: feed,
    // Public and identical for everyone, so it caches. That is only true
    // because there is no per-visitor field in the body — the SPA draws its own
    // "You" badge by comparing each row's buyer against the bootstrap payload.
    headers: { "Cache-Control": "public, max-age=10" },
  };
};

// ------------------------------------------------------------------- payloads

/**
 * The PRIVATE order payload. It carries `download_path`, which on a paid order
 * is a live download URL — see `feedPayload` for why these two must never
 * converge.
 */
export const orderPayload = (record: ShopOrderRecord): ShopOrderPayload => ({
  reference: record.order.id,
  state: record.order.state,
  currency: record.order.currency,
  total_cents: record.order.total_cents,
  total_amount: formatAmount(record.order.total_cents),
  description: checkoutDescription(record),
  paid_at: record.order.paid_at,
  items: record.items.map((item) => ({
    sku: item.sku,
    name: item.name || item.sku,
    quantity: item.quantity,
    unit_price_cents: item.unit_price_cents,
    // Present only once the order is paid: the SPA renders a download button
    // from this and nothing else.
    download_path: isPaid(record) ? downloadPath(record.order.id, item.sku) : null,
  })),
});

/**
 * A SECOND payload function ON PURPOSE, and an explicit WHITELIST — never a
 * reject-list, never a spread of the private payload minus a key.
 *
 * The natural failure mode is reusing the private payload here because it is
 * already written. It carries `download_path`, and for a paid order that is a
 * live download URL for somebody else's purchase.
 *
 * The order id is excluded because `shop_orders.id` IS the OpenReceive
 * reference: the key `checkout.prepare` and `checkout.create` are called with,
 * protected only by `authorize`. It has no business in a public payload, a
 * truncated prefix buys nothing, and the SPA keys its rows on the array index.
 */
export const feedPayload = (record: ShopOrderRecord, buyer: string | null): ShopFeedOrder => ({
  buyer,
  total_cents: record.order.total_cents,
  total_amount: formatAmount(record.order.total_cents),
  currency: record.order.currency,
  paid_at: record.order.paid_at,
  items: record.items.map((item) => ({
    sku: item.sku,
    name: item.name || item.sku,
    quantity: item.quantity,
    image_url: imageUrl(item.image_name),
  })),
});
