import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  InMemoryInvoiceKvStore,
  isOpenReceiveErrorCode,
  StaticPriceProvider,
} from "../../packages/js/core/src/index.ts";
import {
  guestCheckout,
  createOpenReceiveHttpHandler,
  ORDER_TOKEN_COOKIE_NAME,
  withUser,
} from "../../packages/js/http/src/index.ts";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import { TestkitReceiveClient } from "../../packages/js/testkit/src/index.ts";

const BASE = "http://openreceive.test";

// A hermetic OpenReceive service: testkit wallet + in-memory store + the static $50,000/BTC price
// provider, with automated swaps disabled. configPath:false keeps the developer's local
// openreceive.yml out of the test.
async function makeService(overrides = {}) {
  return await createOpenReceive({
    configPath: false,
    client: new TestkitReceiveClient(),
    store: new InMemoryInvoiceKvStore(),
    namespace: "http_test",
    clock: () => 1000,
    priceProviders: [new StaticPriceProvider()],
    swap: { providers: [] },
    ...overrides,
  });
}

// Default pricing for tests: 200 sats unless a test supplies its own resolveOrder.
const defaultResolveOrder = () => ({ amount: { sats: 200 } });

// Handlers warn when authorize is omitted; silence that noise here.
function createHandlerSilently(options) {
  const original = console.warn;
  console.warn = () => {};
  try {
    return createOpenReceiveHttpHandler({
      resolveOrder: defaultResolveOrder,
      ...options,
    });
  } finally {
    console.warn = original;
  }
}

async function buildHandler(options = {}) {
  const service = options.service ?? (await makeService());
  return createHandlerSilently({ service, ...options });
}

function jsonRequest(method, path, { body, headers } = {}) {
  const init = { method, headers: { ...(headers ?? {}) } };
  if (body !== undefined) {
    init.headers["content-type"] = init.headers["content-type"] ?? "application/json";
    init.body = JSON.stringify(body);
  }
  return new Request(`${BASE}${path}`, init);
}

async function createCheckout(handler, { orderId, token } = {}) {
  const response = await handler(
    jsonRequest("POST", "/openreceive/checkouts", {
      body: { order_id: orderId },
      headers: token === undefined ? undefined : { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(response.status, 201, "checkout create should return 201");
  return await response.json();
}

test("checkout.create returns 201 with a checkout and a one-time order_access_token", async () => {
  const handler = await buildHandler();

  const first = await createCheckout(handler, { orderId: "order-token-1" });
  assert.equal(typeof first.checkout, "object");
  assert.equal(first.checkout.order_id, "order-token-1");
  assert.equal(first.checkout.status, "open");
  assert.equal(first.checkout.amount_msats, 200000);
  assert.equal(typeof first.order_access_token, "string");
  assert.ok(first.order_access_token.length > 0);

  // A second checkout for the SAME order replays the order and returns no token.
  const second = await createCheckout(handler, { orderId: "order-token-1" });
  assert.equal(second.order_access_token, undefined);
  assert.equal(second.checkout.checkout_id, first.checkout.checkout_id);
});

test("order.read is denied without a token and allowed with the minted token (default policy)", async () => {
  const handler = await buildHandler();
  const created = await createCheckout(handler, { orderId: "order-read-1" });
  const token = created.order_access_token;

  const denied = await handler(
    jsonRequest("POST", "/openreceive/orders/order-read-1", { body: {} }),
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");

  const allowed = await handler(
    jsonRequest("POST", "/openreceive/orders/order-read-1", {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(allowed.status, 200);
  const status = await allowed.json();
  assert.equal(status.order_id, "order-read-1");
  assert.equal(status.status, "pending");
  assert.equal(status.swaps_enabled, false);
  assert.deepEqual(status.swap_pay_options, []);
});

test("checkout.read is gated by the per-order token (200 with, 403 without)", async () => {
  const handler = await buildHandler();
  const created = await createCheckout(handler, { orderId: "order-checkout-read" });
  const checkoutId = created.checkout.checkout_id;
  const token = created.order_access_token;

  const denied = await handler(jsonRequest("GET", `/openreceive/checkouts/${checkoutId}`));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");

  const allowed = await handler(
    jsonRequest("GET", `/openreceive/checkouts/${checkoutId}`, {
      headers: { "x-openreceive-order-token": token },
    }),
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).checkout_id, checkoutId);
});

test("rates is a public GET returning the static rate map", async () => {
  const handler = await buildHandler();
  const response = await handler(jsonRequest("GET", "/openreceive/rates"));
  assert.equal(response.status, 200);
  const rates = await response.json();
  assert.equal(rates.bitcoin.usd, "50000.00");
});

test("admin/sweep fails closed by default and opens for an allow-all authorize", async () => {
  const denied = await handler_sweep(undefined);
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");

  const allowed = await handler_sweep(() => true);
  assert.equal(allowed.status, 200);
  const result = await allowed.json();
  assert.equal(typeof result, "object");
  assert.notEqual(result, null);
});

async function handler_sweep(authorize) {
  const service = await makeService();
  const handler = createHandlerSilently({
    service,
    ...(authorize === undefined ? {} : { authorize }),
  });
  return await handler(jsonRequest("POST", "/openreceive/admin/sweep", { body: {} }));
}

test("a custom authorize policy governs order.read (deny -> 403, allow -> 200)", async () => {
  const denyService = await makeService();
  const denyHandler = createHandlerSilently({
    service: denyService,
    authorize: (ctx) => ctx.action !== "order.read",
  });
  await createCheckout(denyHandler, { orderId: "order-custom-deny" });
  const denied = await denyHandler(
    jsonRequest("POST", "/openreceive/orders/order-custom-deny", { body: {} }),
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");

  const allowService = await makeService();
  const allowHandler = createHandlerSilently({ service: allowService, authorize: () => true });
  await createCheckout(allowHandler, { orderId: "order-custom-allow" });
  const allowed = await allowHandler(
    jsonRequest("POST", "/openreceive/orders/order-custom-allow", { body: {} }),
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).order_id, "order-custom-allow");
});

test("resolveOrder is the sole price authority; client amount fields are rejected", async () => {
  const service = await makeService();
  const handler = createHandlerSilently({
    service,
    resolveOrder: () => ({ amount: { currency: "USD", value: "1.00" } }),
  });

  const rejected = await handler(
    jsonRequest("POST", "/openreceive/checkouts", {
      body: { order_id: "order-forged", usd: "999999" },
    }),
  );
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json()).code, "INVALID_REQUEST");

  const response = await handler(
    jsonRequest("POST", "/openreceive/checkouts", {
      body: { order_id: "order-priced" },
    }),
  );
  assert.equal(response.status, 201);
  const { checkout } = await response.json();
  // $1.00 at $50,000/BTC = 2,000 sats = 2,000,000 msats.
  assert.equal(checkout.amount_msats, 2000000);
  assert.equal(checkout.fiat.currency, "USD");
  assert.equal(checkout.fiat.value, "1.00");
});

test("resolveOrder null returns 404 and throw returns 400", async () => {
  const missing = createHandlerSilently({
    service: await makeService(),
    resolveOrder: () => null,
  });
  const notFound = await missing(
    jsonRequest("POST", "/openreceive/checkouts", { body: { order_id: "missing" } }),
  );
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).code, "NOT_FOUND");

  const invalid = createHandlerSilently({
    service: await makeService(),
    resolveOrder: () => {
      throw new Error("bad tip");
    },
  });
  const bad = await invalid(
    jsonRequest("POST", "/openreceive/checkouts", { body: { order_id: "bad" } }),
  );
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "INVALID_REQUEST");
});

test("error responses conform to the shared shape (enum code, non-empty message, request id)", async () => {
  const handler = await buildHandler();
  const response = await handler(
    jsonRequest("POST", "/openreceive/checkouts", { body: { usd: "1.00" } }),
  );
  assert.equal(response.status, 400);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(response.headers.get("x-request-id"));

  const body = await response.json();
  assert.equal(isOpenReceiveErrorCode(body.code), true);
  assert.equal(body.code, "INVALID_REQUEST");
  assert.equal(typeof body.message, "string");
  assert.ok(body.message.length > 0);
  assert.equal(typeof body.request_id, "string");
  assert.ok(body.request_id.length > 0);
});

test("swap-options and order swap actions expose the disabled-swap shape", async () => {
  const handler = await buildHandler();
  const created = await createCheckout(handler, { orderId: "order-swap-min" });
  const token = created.order_access_token;

  const options = await handler(
    jsonRequest("GET", "/openreceive/orders/order-swap-min/swap-options", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(options.status, 200);
  assert.deepEqual(await options.json(), { enabled: false, options: [] });

  // A swap_quote action routes through authorize (swap.quote) to the service and comes back in a
  // { quote } envelope. With swaps disabled the service returns an unavailable catalog option.
  const quote = await handler(
    jsonRequest("POST", "/openreceive/orders/order-swap-min", {
      body: { action: "swap_quote", pay_in_asset: "USDT_TRON" },
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(quote.status, 200);
  const quoteBody = await quote.json();
  assert.equal(typeof quoteBody.quote, "object");
  assert.equal(quoteBody.quote.pay_in_asset, "USDT_TRON");
  assert.equal(quoteBody.quote.available, false);

  // The swap_quote action is gated: without the token it is denied (403).
  const denied = await handler(
    jsonRequest("POST", "/openreceive/orders/order-swap-min", {
      body: { action: "swap_quote", pay_in_asset: "USDT_TRON" },
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");
});

test("the handler requires resolveOrder and warns only about missing authorize", async () => {
  const service = await makeService();
  assert.throws(
    () => createOpenReceiveHttpHandler({ service }),
    /resolveOrder/,
  );

  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(message);
  let handler;
  try {
    handler = createOpenReceiveHttpHandler({ service, resolveOrder: defaultResolveOrder });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1);
  assert.ok(warnings.some((message) => /Tier-3 admin routes/.test(message)));

  assert.equal(handler.prefix, "/openreceive");
  assert.equal(typeof handler.handle, "function");
  const viaHandle = await handler.handle(jsonRequest("GET", "/openreceive/rates"));
  assert.equal(viaHandle.status, 200);
});

test("a custom prefix mounts the routes and outside paths 404", async () => {
  const service = await makeService();
  const handler = createHandlerSilently({ service, prefix: "/pay/" });
  assert.equal(handler.prefix, "/pay");

  const ok = await handler(jsonRequest("GET", "/pay/rates"));
  assert.equal(ok.status, 200);

  const miss = await handler(jsonRequest("GET", "/openreceive/rates"));
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).code, "NOT_FOUND");
});

// ---------------------------------------------------------------------------
// tokenValid context + authorize presets (Feature 1)
// ---------------------------------------------------------------------------

test("tokenValid is precomputed and exposed to a custom authorize", async () => {
  const service = await makeService();
  let seen;
  const handler = createHandlerSilently({
    service,
    authorize: (ctx) => {
      if (ctx.action === "order.read") seen = ctx.tokenValid;
      return true; // allow so we can both create and read through this handler
    },
  });
  const created = await createCheckout(handler, { orderId: "order-token-valid" });
  const token = created.order_access_token;

  await handler(
    jsonRequest("POST", "/openreceive/orders/order-token-valid", {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(seen, true, "a valid token makes ctx.tokenValid true");

  await handler(
    jsonRequest("POST", "/openreceive/orders/order-token-valid", {
      body: {},
      headers: { authorization: "Bearer wrong-token" },
    }),
  );
  assert.equal(seen, false, "a wrong token makes ctx.tokenValid false");

  await handler(jsonRequest("POST", "/openreceive/orders/order-token-valid", { body: {} }));
  assert.equal(seen, false, "no token makes ctx.tokenValid false");
});

test("guestCheckout() gates reads on the order token and allows anonymous checkout.create", async () => {
  const service = await makeService();
  const handler = createHandlerSilently({ service, authorize: guestCheckout() });

  // Anonymous checkout.create is allowed and mints a token.
  const created = await createCheckout(handler, { orderId: "order-content" });
  const token = created.order_access_token;
  assert.ok(token);

  const denied = await handler(
    jsonRequest("POST", "/openreceive/orders/order-content", { body: {} }),
  );
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");

  const allowed = await handler(
    jsonRequest("POST", "/openreceive/orders/order-content", {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).order_id, "order-content");
});

test("guestCheckout() denies sweep unless allowSweep returns true", async () => {
  const denied = await handler_sweep(guestCheckout());
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");

  const allowed = await handler_sweep(guestCheckout({ allowSweep: () => true }));
  assert.equal(allowed.status, 200);
});

test("withUser allows order actions when getUser + ownsOrder resolve, denies otherwise", async () => {
  const service = await makeService();
  const seed = createHandlerSilently({ service, authorize: () => true });
  const created = await createCheckout(seed, { orderId: "order-user" });
  const token = created.order_access_token;

  // A user who owns the order is allowed even without presenting the token.
  const owns = createHandlerSilently({
    service,
    authorize: withUser(() => ({ id: 1 }), { ownsOrder: () => true }),
  });
  const allowed = await owns(jsonRequest("POST", "/openreceive/orders/order-user", { body: {} }));
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).order_id, "order-user");

  // A user who does not own the order is denied.
  const notOwner = createHandlerSilently({
    service,
    authorize: withUser(() => ({ id: 1 }), { ownsOrder: () => false }),
  });
  const deniedOwner = await notOwner(
    jsonRequest("POST", "/openreceive/orders/order-user", { body: {} }),
  );
  assert.equal(deniedOwner.status, 403);

  // No logged-in user is denied everything.
  const anon = createHandlerSilently({ service, authorize: withUser(() => undefined) });
  const deniedAnon = await anon(
    jsonRequest("POST", "/openreceive/orders/order-user", { body: {} }),
  );
  assert.equal(deniedAnon.status, 403);

  // With no ownsOrder callback, a logged-in user falls back to the order token (ctx.tokenValid).
  const fallback = createHandlerSilently({ service, authorize: withUser(() => ({ id: 1 })) });
  const withToken = await fallback(
    jsonRequest("POST", "/openreceive/orders/order-user", {
      body: {},
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  assert.equal(withToken.status, 200);
  const withoutToken = await fallback(
    jsonRequest("POST", "/openreceive/orders/order-user", { body: {} }),
  );
  assert.equal(withoutToken.status, 403);
});

test("withUser gates sweep on isAdmin", async () => {
  const denied = await handler_sweep(withUser(() => ({ id: 1 }), { isAdmin: () => false }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "UNAUTHORIZED");

  const allowed = await handler_sweep(withUser(() => ({ id: 1 }), { isAdmin: () => true }));
  assert.equal(allowed.status, 200);
});

// ---------------------------------------------------------------------------
// Order-token cookie (Feature 2)
// ---------------------------------------------------------------------------

test("checkout.create sets a path-scoped httpOnly order-token cookie", async () => {
  const handler = await buildHandler();
  const response = await handler(
    jsonRequest("POST", "/openreceive/checkouts", {
      body: { order_id: "order-cookie-1" },
    }),
  );
  assert.equal(response.status, 201);

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header on the create response");
  const { order_access_token } = await response.json();
  assert.ok(setCookie.startsWith(`${ORDER_TOKEN_COOKIE_NAME}=${order_access_token}`));
  assert.match(setCookie, /Path=\/openreceive\/orders\/order-cookie-1/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=86400/);
  assert.doesNotMatch(setCookie, /Secure/); // http request -> no Secure
});

test("a same-origin read authorizes via the order-token cookie alone (no Authorization header)", async () => {
  const handler = await buildHandler();
  const created = await createCheckout(handler, { orderId: "order-cookie-read" });
  const token = created.order_access_token;

  const allowed = await handler(
    jsonRequest("POST", "/openreceive/orders/order-cookie-read", {
      body: {},
      headers: { cookie: `${ORDER_TOKEN_COOKIE_NAME}=${token}` },
    }),
  );
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).order_id, "order-cookie-read");

  const wrong = await handler(
    jsonRequest("POST", "/openreceive/orders/order-cookie-read", {
      body: {},
      headers: { cookie: `${ORDER_TOKEN_COOKIE_NAME}=not-the-token` },
    }),
  );
  assert.equal(wrong.status, 403);
  assert.equal((await wrong.json()).code, "UNAUTHORIZED");
});

test("the order-token cookie is Secure over https (direct or forwarded) and not over http", async () => {
  const handler = await buildHandler();

  const httpsResponse = await handler(
    new Request("https://openreceive.test/openreceive/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_id: "order-cookie-https" }),
    }),
  );
  assert.equal(httpsResponse.status, 201);
  assert.match(httpsResponse.headers.get("set-cookie"), /;\s*Secure/);

  const forwardedResponse = await handler(
    jsonRequest("POST", "/openreceive/checkouts", {
      body: { order_id: "order-cookie-fwd" },
      headers: { "x-forwarded-proto": "https" },
    }),
  );
  assert.equal(forwardedResponse.status, 201);
  assert.match(forwardedResponse.headers.get("set-cookie"), /;\s*Secure/);

  const httpResponse = await handler(
    jsonRequest("POST", "/openreceive/checkouts", {
      body: { order_id: "order-cookie-http" },
    }),
  );
  assert.equal(httpResponse.status, 201);
  assert.doesNotMatch(httpResponse.headers.get("set-cookie"), /Secure/);
});

// ---------------------------------------------------------------------------
// Golden vectors: the cross-adapter / cross-language parity oracle.
// ---------------------------------------------------------------------------

const goldenDir = fileURLToPath(new URL("../../spec/test-vectors/http-golden/", import.meta.url));
const goldenVectors = readdirSync(goldenDir)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    file: name,
    vector: JSON.parse(readFileSync(new URL(name, `file://${goldenDir}`), "utf8")),
  }));

function assertBodyIncludes(actual, expected, path) {
  for (const [key, value] of Object.entries(expected)) {
    const actualValue = actual === null || actual === undefined ? undefined : actual[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      assertBodyIncludes(actualValue, value, `${path}.${key}`);
    } else {
      assert.deepEqual(actualValue, value, `golden body mismatch at ${path}.${key}`);
    }
  }
}

test("golden vectors are loaded", () => {
  assert.ok(goldenVectors.length >= 4, "expected at least 4 golden vectors");
});

for (const { file, vector } of goldenVectors) {
  test(`golden: ${vector.name} (${file})`, async () => {
    const handler = await buildHandler();
    const request = jsonRequest(vector.request.method, vector.request.path, {
      body: vector.request.body,
      headers: vector.request.headers,
    });
    const response = await handler(request);
    assert.equal(response.status, vector.expected.status, `status for ${file}`);

    const body = await response.json().catch(() => undefined);
    if (vector.expected.error_code !== undefined) {
      assert.equal(body?.code, vector.expected.error_code, `error_code for ${file}`);
      assert.equal(isOpenReceiveErrorCode(body?.code), true);
    }
    if (vector.expected.body_includes !== undefined) {
      assertBodyIncludes(body, vector.expected.body_includes, "body");
    }
  });
}
