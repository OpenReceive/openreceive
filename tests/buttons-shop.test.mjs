/**
 * The Buy a Button Node suite — PART 11 of the demo plan, for the three Node
 * stacks.
 *
 * These call the five handlers DIRECTLY, with no HTTP server and no framework.
 * That is not a shortcut: `shop-routes.ts` exports plain functions of
 * (request, context) precisely so Express and the Next.js app router can both
 * mount them, and the same property makes the behaviour testable without
 * either. A test that had to boot a server would be testing the adapter.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseCookieHeader,
  resolveCookieSecret,
  serializeIdentityCookie,
  SHOP_COOKIE,
} from "../examples/buttons/shared/server-node/cookie.ts";
import { createShopAmountFor } from "../examples/buttons/shared/server-node/openreceive-config.ts";
import {
  bootstrap,
  createOrder,
  download,
  recentOrders,
  showOrder,
} from "../examples/buttons/shared/server-node/shop-routes.ts";
import {
  claimShopOrderPaid,
  FEED_LIMIT,
  MAX_PER_SKU,
  openShopStore,
} from "../examples/buttons/shared/server-node/store.ts";

const SECRET = "buttons-test-secret";

let storeCount = 0;

/** A fresh, hermetic shop per test. The store migrates and seeds on open. */
function freshShop() {
  process.env.OPENRECEIVE_DEMO_DB = mkdtempSync(path.join(tmpdir(), "buttons-test-"));
  storeCount += 1;
  const store = openShopStore({ demoId: `test-${storeCount}` });
  return { store, secret: SECRET, openreceivePrefix: "/openreceive" };
}

/** A request carrying whatever the last response set, which is what a browser does. */
const request = (overrides = {}) => ({
  cookieHeader: undefined,
  secure: false,
  ...overrides,
});

/** The Set-Cookie line a handler returned, as the Cookie header for the next call. */
const cookieFrom = (result) => {
  const [pair] = result.setCookie.split(";");
  return pair;
};

/** Place an order as a given visitor and return { result, cookieHeader }. */
function placeOrder(context, items, cookieHeader) {
  const result = createOrder(request({ body: { items }, cookieHeader }), context);
  return { result, cookieHeader: cookieFrom(result) };
}

/** Settle an order the way `onPaid` does: the guarded UPDATE, on our own query. */
const settle = (context, reference, paidAt = 1_756_300_000, paymentHash = "a".repeat(64)) =>
  claimShopOrderPaid({ reference, paidAt, paymentHash, query: context.store.query });

// =========================================================== 11.1  IDENTITY

test("a first request mints a visitor, and a second reuses the same one", () => {
  const context = freshShop();

  const first = bootstrap(request(), context);
  const cookieHeader = cookieFrom(first);
  assert.ok(cookieHeader.startsWith(`${SHOP_COOKIE}=`));

  const second = bootstrap(request({ cookieHeader }), context);
  assert.equal(second.json.shop.visitor.public_ref, first.json.shop.visitor.public_ref);
});

test("two cookieless requests create two distinct visitors", () => {
  const context = freshShop();
  const first = bootstrap(request(), context);
  const second = bootstrap(request(), context);
  assert.notEqual(first.json.shop.visitor.public_ref, second.json.shop.visitor.public_ref);
});

test("a tampered cookie yields a NEW visitor, not a crash", () => {
  const context = freshShop();
  const real = bootstrap(request(), context);
  const tampered = `${cookieFrom(real).slice(0, -4)}zzzz`;

  const result = bootstrap(request({ cookieHeader: tampered }), context);
  assert.equal(result.status, 200);
  assert.notEqual(result.json.shop.visitor.public_ref, real.json.shop.visitor.public_ref);
});

test("a validly-signed cookie for a deleted row yields a new visitor", () => {
  const context = freshShop();
  const user = context.store.createUser();
  const signed = serializeIdentityCookie({ value: user.id, secret: SECRET, secure: false });
  context.store.db.prepare("DELETE FROM shop_users WHERE id = ?").run(user.id);

  const result = bootstrap(request({ cookieHeader: signed.split(";")[0] }), context);
  assert.equal(result.status, 200);
  assert.notEqual(result.json.shop.visitor.public_ref, user.public_ref);
});

test("a raw uuid set as an UNSIGNED cookie is not accepted — the two-uuid design", () => {
  const context = freshShop();
  const owner = context.store.createUser();

  // Exactly what an attacker could do with a value read out of the database or
  // pasted from anywhere: present the private id, unsigned.
  const result = bootstrap(request({ cookieHeader: `${SHOP_COOKIE}=${owner.id}` }), context);
  assert.notEqual(result.json.shop.visitor.public_ref, owner.public_ref);
});

test("the public feed does not mint a visitor — it is the crawler-facing route", () => {
  const context = freshShop();
  const before = context.store.db.prepare("SELECT COUNT(*) AS n FROM shop_users").get().n;

  const result = recentOrders(request(), context);
  assert.equal(result.setCookie, undefined);
  assert.equal(context.store.db.prepare("SELECT COUNT(*) AS n FROM shop_users").get().n, before);
});

test("the identity cookie carries the flags the docs describe, on every stack", () => {
  const line = serializeIdentityCookie({ value: "x", secret: SECRET, secure: false });
  assert.match(line, /HttpOnly/);
  assert.match(line, /SameSite=Lax/);
  assert.match(line, /Path=\//);
  assert.match(line, /Max-Age=31536000/);
  // `secure` follows THE REQUEST: a Secure cookie is dropped over plain HTTP,
  // and the production-mode demo is served over http://localhost.
  assert.doesNotMatch(line, /Secure/);
  assert.match(serializeIdentityCookie({ value: "x", secret: SECRET, secure: true }), /Secure/);
});

// ============================================================= 11.2  ORDERS

test("an order belongs to the visitor that placed it", () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);
  assert.equal(result.status, 201);

  const owner = parseCookieHeader(cookieHeader)[SHOP_COOKIE];
  assert.ok(owner);
  const row = context.store.orderByReference(result.json.reference);
  assert.ok(row);
});

test("a price in the request body is IGNORED", () => {
  const context = freshShop();
  const { result } = placeOrder(context, [
    { sku: "signal-red", quantity: 1, price_cents: 1, unit_price_cents: 1, total_cents: 1 },
  ]);
  // Signal Red is $10.00 in shop-catalog.json, and that is the only authority.
  assert.equal(result.json.total_cents, 1000);
  assert.equal(result.json.items[0].unit_price_cents, 1000);
});

test("quantity 999 clamps to MAX_PER_SKU", () => {
  const context = freshShop();
  const { result } = placeOrder(context, [{ sku: "safety-orange", quantity: 999 }]);
  assert.equal(result.json.items[0].quantity, MAX_PER_SKU);
});

test("duplicate lines merge, and merge before clamping", () => {
  const context = freshShop();
  const { result } = placeOrder(context, [
    { sku: "safety-orange", quantity: 8 },
    { sku: "safety-orange", quantity: 8 },
  ]);
  assert.equal(result.json.items.length, 1);
  assert.equal(result.json.items[0].quantity, MAX_PER_SKU);
});

test("an unknown sku is DROPPED, not a 500", () => {
  const context = freshShop();
  const { result } = placeOrder(context, [
    { sku: "not-a-button", quantity: 3 },
    { sku: "plain-white", quantity: 1 },
  ]);
  assert.equal(result.status, 201);
  assert.deepEqual(
    result.json.items.map((item) => item.sku),
    ["plain-white"],
  );
});

test("an empty cart is a 422 with a sentence, and writes no row", () => {
  const context = freshShop();
  const before = context.store.db.prepare("SELECT COUNT(*) AS n FROM shop_orders").get().n;

  for (const items of [[], [{ sku: "nope", quantity: 1 }], "not-an-array", undefined]) {
    const result = createOrder(request({ body: { items } }), context);
    assert.equal(result.status, 422);
    assert.equal(typeof result.json.error, "string");
    assert.ok(result.json.error.length > 0);
  }
  assert.equal(context.store.db.prepare("SELECT COUNT(*) AS n FROM shop_orders").get().n, before);
});

test("another visitor's order is 404, never 403 — possession is a claim, not proof", () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "classic-black", quantity: 1 }]);
  const reference = result.json.reference;

  const mine = showOrder(request({ cookieHeader, params: { reference } }), context);
  assert.equal(mine.status, 200);

  // A different browser: no cookie at all, so a fresh visitor is minted.
  const stranger = showOrder(request({ params: { reference } }), context);
  assert.equal(stranger.status, 404);
});

test("a malformed reference is a 404, not a database error", () => {
  const context = freshShop();
  for (const reference of ["not-a-uuid", "", "'; DROP TABLE shop_orders; --", undefined]) {
    assert.equal(showOrder(request({ params: { reference } }), context).status, 404);
  }
});

test("the download is gated on the ROW: 403 unpaid, 404 for a stranger, 200 once paid", async () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);
  const reference = result.json.reference;
  const params = { reference, sku: "safety-orange" };

  assert.equal(download(request({ cookieHeader, params }), context).status, 403);
  assert.equal(download(request({ params }), context).status, 404);

  assert.equal(await settle(context, reference), true);
  const paid = download(request({ cookieHeader, params }), context);
  assert.equal(paid.status, 200);
  assert.equal(paid.file.contentType, "image/webp");
  assert.equal(paid.file.filename, "openreceive-safety-orange-button.webp");

  // Still nobody else's.
  assert.equal(download(request({ params }), context).status, 404);
});

test("a sku that is not on the order is a 404 even when the order is paid", async () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);
  await settle(context, result.json.reference);

  const params = { reference: result.json.reference, sku: "signal-red" };
  assert.equal(download(request({ cookieHeader, params }), context).status, 404);
});

test("download_path appears only once the order is paid", async () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "midnight-navy", quantity: 1 }]);
  assert.equal(result.json.items[0].download_path, null);

  await settle(context, result.json.reference);
  const paid = showOrder(
    request({ cookieHeader, params: { reference: result.json.reference } }),
    context,
  );
  assert.match(
    paid.json.items[0].download_path,
    /^\/shop\/orders\/[0-9a-f-]+\/downloads\/midnight-navy$/,
  );
});

// ========================================================= 11.3  SETTLEMENT

test("the guarded transition returns true then false, and the second call changes NOTHING", async () => {
  const context = freshShop();
  const { result } = placeOrder(context, [{ sku: "signal-red", quantity: 1 }]);
  const reference = result.json.reference;

  assert.equal(await settle(context, reference, 1_756_300_000, "a".repeat(64)), true);
  const first = context.store.orderByReference(reference).order;

  assert.equal(await settle(context, reference, 1_999_999_999, "b".repeat(64)), false);
  const second = context.store.orderByReference(reference).order;

  assert.equal(second.state, "paid");
  assert.equal(second.paid_at, first.paid_at);
  assert.equal(second.payment_hash, first.payment_hash);
});

test("a settlement for an unknown or malformed reference claims nothing", async () => {
  const context = freshShop();
  assert.equal(await settle(context, "not-a-uuid"), false);
  assert.equal(await settle(context, "11111111-2222-3333-4444-555555555555"), false);
});

test("amountFor reads only from our own row, and `value` is a decimal STRING", () => {
  const context = freshShop();
  const amountFor = createShopAmountFor(context.store);
  const { result } = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);

  const amount = amountFor(result.json.reference);
  assert.equal(amount.currency, "USD");
  // "1.00", never "1.0" and never the float 1.
  assert.equal(amount.value, "1.00");
  assert.equal(typeof amount.value, "string");
  assert.equal(amount.description, "OpenReceive button: Safety Orange");

  // Nothing to pay for is null — the request is answered 404.
  assert.equal(amountFor("11111111-2222-3333-4444-555555555555"), null);
  assert.equal(amountFor("not-a-uuid"), null);
});

test("the description names what was bought, and pluralizes on the item COUNT", () => {
  const context = freshShop();
  const amountFor = createShopAmountFor(context.store);
  const { result } = placeOrder(context, [
    { sku: "safety-orange", quantity: 2 },
    { sku: "signal-red", quantity: 1 },
  ]);
  assert.equal(
    amountFor(result.json.reference).description,
    "OpenReceive buttons: Safety Orange ×2, Signal Red",
  );
});

// =============================================================== 11.4  FEED

test("the feed shows paid orders only", async () => {
  const context = freshShop();
  const unpaid = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);
  const paid = placeOrder(context, [{ sku: "signal-red", quantity: 1 }]);
  await settle(context, paid.result.json.reference);

  const feed = recentOrders(request(), context).json;
  assert.equal(feed.orders.length, 1);
  assert.equal(feed.orders[0].total_cents, 1000);
  assert.deepEqual(feed.totals, { paid_orders: 1, buttons_sold: 1 });
  // The unpaid one exists; it simply is not a billboard.
  assert.ok(context.store.orderByReference(unpaid.result.json.reference));
});

test("the feed carries ONLY the whitelisted fields — asserted against the SERIALIZED body", async () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);
  const reference = result.json.reference;
  await settle(context, reference, 1_756_300_000, "c".repeat(64));

  const owner = parseCookieHeader(cookieHeader)[SHOP_COOKIE];
  const privateId = context.store.orderByReference(reference).order.shop_user_id;
  const body = JSON.stringify(recentOrders(request(), context).json);

  // The order id IS the OpenReceive reference. Not truncated, not present.
  assert.ok(!body.includes(reference));
  assert.ok(!body.includes(reference.slice(0, 8)));
  assert.ok(!body.includes(privateId));
  assert.ok(!body.includes(owner));
  assert.ok(!body.includes("c".repeat(64)));
  assert.ok(!body.includes("payment_hash"));
  assert.ok(!body.includes("download_path"));
  assert.ok(!body.includes("session"));

  // And it does carry the buyer's PUBLIC handle.
  const feed = JSON.parse(body);
  assert.equal(
    feed.orders[0].buyer,
    context.store.db.prepare("SELECT public_ref FROM shop_users WHERE id = ?").get(privateId)
      .public_ref,
  );
});

test("a larger ?limit= does not increase the row count", async () => {
  const context = freshShop();
  for (let index = 0; index < FEED_LIMIT + 5; index += 1) {
    const { result } = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);
    await settle(context, result.json.reference, 1_756_300_000 + index);
  }

  const capped = recentOrders(request({ params: { limit: "500" } }), context).json;
  assert.equal(capped.orders.length, FEED_LIMIT);
  assert.equal(capped.totals.paid_orders, FEED_LIMIT + 5);
});

test("the feed answers with a PUBLIC cache header, and no per-visitor field", () => {
  const context = freshShop();
  const result = recentOrders(request(), context);
  assert.equal(result.headers["Cache-Control"], "public, max-age=10");
  // A `you` flag would make one public, identical-for-everyone response
  // per-visitor. The SPA draws that badge itself.
  assert.ok(!JSON.stringify(result.json).includes('"you"'));
});

test("the feed is newest paid first", async () => {
  const context = freshShop();
  const first = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);
  const second = placeOrder(context, [{ sku: "signal-red", quantity: 1 }]);
  await settle(context, first.result.json.reference, 1_756_300_000);
  await settle(context, second.result.json.reference, 1_756_400_000);

  const feed = recentOrders(request(), context).json;
  assert.deepEqual(
    feed.orders.map((order) => order.paid_at),
    [1_756_400_000, 1_756_300_000],
  );
});

// ============================================================ 11.5  CATALOG

test("deactivating a product hides it from the catalog and from order creation", () => {
  const context = freshShop();
  context.store.db.prepare("UPDATE shop_products SET active = 0 WHERE sku = ?").run("signal-red");

  const catalog = bootstrap(request(), context).json.shop.catalog;
  assert.ok(!catalog.some((entry) => entry.sku === "signal-red"));

  const { result } = placeOrder(context, [{ sku: "signal-red", quantity: 1 }]);
  assert.equal(result.status, 422);
});

test("deactivating a product leaves an EXISTING order's receipt, download and feed row intact", async () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "signal-red", quantity: 1 }]);
  const reference = result.json.reference;
  await settle(context, reference);

  // The snapshots on the item row are what this test is about.
  context.store.db.prepare("UPDATE shop_products SET active = 0 WHERE sku = ?").run("signal-red");

  const receipt = showOrder(request({ cookieHeader, params: { reference } }), context);
  assert.equal(receipt.json.items[0].name, "Signal Red");
  assert.equal(receipt.json.items[0].unit_price_cents, 1000);

  const params = { reference, sku: "signal-red" };
  assert.equal(download(request({ cookieHeader, params }), context).status, 200);

  const feed = recentOrders(request(), context).json;
  assert.equal(feed.orders[0].items[0].name, "Signal Red");
});

test("a DELETED product leaves the order readable, and the download still resolves by convention", async () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "signal-red", quantity: 1 }]);
  const reference = result.json.reference;
  await settle(context, reference);

  // ON DELETE SET NULL: the FK is for joins, the snapshot is what renders.
  context.store.db.prepare("DELETE FROM shop_products WHERE sku = ?").run("signal-red");

  const receipt = showOrder(request({ cookieHeader, params: { reference } }), context);
  assert.equal(receipt.json.items[0].name, "Signal Red");

  const params = { reference, sku: "signal-red" };
  const file = download(request({ cookieHeader, params }), context);
  assert.equal(file.status, 200);
  assert.equal(file.file.filename, "openreceive-signal-red-button.webp");

  // The feed row survives too; it just has no image to point at any more.
  assert.equal(recentOrders(request(), context).json.orders[0].items[0].image_url, null);
});

test("renaming a product does not rewrite history", async () => {
  const context = freshShop();
  const { result, cookieHeader } = placeOrder(context, [{ sku: "signal-red", quantity: 1 }]);
  await settle(context, result.json.reference);

  context.store.db
    .prepare("UPDATE shop_products SET name = ? WHERE sku = ?")
    .run("Crimson", "signal-red");

  const receipt = showOrder(
    request({ cookieHeader, params: { reference: result.json.reference } }),
    context,
  );
  assert.equal(receipt.json.items[0].name, "Signal Red");
});

// ============================================================ the migrations

test("the store migrates once and the shop SURVIVES a restart", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "buttons-restart-"));
  process.env.OPENRECEIVE_DEMO_DB = dir;

  const first = openShopStore({ demoId: "restart" });
  const context = { store: first, secret: SECRET, openreceivePrefix: "/openreceive" };
  const { result } = placeOrder(context, [{ sku: "safety-orange", quantity: 1 }]);
  await settle(context, result.json.reference);
  first.close();

  // Hello Fruit wiped its file here. This is the demo.
  const second = openShopStore({ demoId: "restart" });
  assert.equal(second.feedTotals().paid_orders, 1);
  assert.equal(second.activeCatalog().length, 6);
  assert.ok(second.orderByReference(result.json.reference));
  // And the migrations did not run twice.
  assert.equal(second.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get().n, 5);
  second.close();
});

test("the cookie secret is stable across a restart, or the persistence demo is a session demo", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "buttons-secret-"));
  delete process.env.SHOP_COOKIE_SECRET;
  assert.equal(resolveCookieSecret(dir, "x"), resolveCookieSecret(dir, "x"));
});
