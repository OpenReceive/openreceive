import assert from "node:assert/strict";
import test from "node:test";
import {
  createGuestCheckoutResume,
  createGuestOrderFetcher,
} from "../../packages/js/browser/src/internal.ts";

/** @typedef {{ id: string; total: string }} DemoOrder */

function parseOrder(value) {
  if (typeof value !== "object" || value === null) return undefined;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (typeof record.id !== "string" || record.id.length === 0) return undefined;
  if (typeof record.total !== "string") return undefined;
  return /** @type {DemoOrder} */ ({ id: record.id, total: record.total });
}

test("createGuestCheckoutResume parses and builds /checkout/:orderId paths", () => {
  const resume = createGuestCheckoutResume({
    storageKeyPrefix: "test.order.",
    orderIdOf: (order) => order.id,
    parseOrder,
  });
  assert.equal(resume.pathPrefix, "/checkout");
  assert.equal(resume.checkoutPath("abc-123"), "/checkout/abc-123");
  assert.equal(resume.parseOrderId("/checkout/abc-123"), "abc-123");
  assert.equal(resume.parseOrderId("/checkout/"), undefined);
  assert.equal(resume.parseOrderId("/shop"), undefined);
  assert.equal(resume.parseOrderId("/checkout/a/b"), undefined);
});

test("createGuestCheckoutResume remembers and loads host orders from sessionStorage", async () => {
  const store = new Map();
  globalThis.sessionStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };

  const resume = createGuestCheckoutResume({
    storageKeyPrefix: "test.order.",
    orderIdOf: (order) => order.id,
    parseOrder,
  });
  const order = { id: "ord_1", total: "9.99" };
  resume.rememberOrder(order);
  assert.deepEqual(resume.readRememberedOrder("ord_1"), order);
  assert.deepEqual(await resume.loadOrderForResume("ord_1"), order);

  resume.forgetOrder("ord_1");
  assert.equal(resume.readRememberedOrder("ord_1"), undefined);

  delete globalThis.sessionStorage;
});

test("createGuestOrderFetcher reads { order } JSON from host GET", async () => {
  const fetchOrder = createGuestOrderFetcher({
    parseOrder,
    fetch: async (url) => {
      assert.equal(url, "/orders/ord_2");
      return {
        ok: true,
        status: 200,
        json: async () => ({ order: { id: "ord_2", total: "1.00" } }),
      };
    },
  });
  assert.deepEqual(await fetchOrder("ord_2"), { id: "ord_2", total: "1.00" });
});

test("createGuestCheckoutResume loadOrderForResume falls back to fetchOrder", async () => {
  globalThis.sessionStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: 0,
  };
  const resume = createGuestCheckoutResume({
    storageKeyPrefix: "test.order.",
    orderIdOf: (order) => order.id,
    parseOrder,
    fetchOrder: async (orderId) =>
      orderId === "ord_3" ? { id: "ord_3", total: "2.50" } : undefined,
  });
  assert.deepEqual(await resume.loadOrderForResume("ord_3"), { id: "ord_3", total: "2.50" });
  assert.equal(await resume.loadOrderForResume("missing"), undefined);
  delete globalThis.sessionStorage;
});
