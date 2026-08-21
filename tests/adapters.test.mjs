import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import * as expressAdapter from "../packages/js/express/src/index.ts";
import { openReceiveExpress } from "../packages/js/express/src/index.ts";
import * as httpSurface from "../packages/js/http/src/index.ts";
import { openReceivePaymentsSchemaSql } from "../packages/js/http/src/index.ts";
import * as fastifyAdapter from "../packages/js/fastify/src/index.ts";
import { openReceiveFastify } from "../packages/js/fastify/src/index.ts";
import * as nextAdapter from "../packages/js/next/src/index.ts";
import { openReceiveNextHandlers } from "../packages/js/next/src/index.ts";
import * as umbrellaExpress from "../packages/js/openreceive/src/express.ts";
import * as umbrellaFastify from "../packages/js/openreceive/src/fastify.ts";
import * as umbrellaNext from "../packages/js/openreceive/src/next.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

function testHost({ countAttemptsFromIp } = {}) {
  const committed = [];
  return {
    committed,
    host: {
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: (input) => committed.push(input),
      onPaid: async () => undefined,
      payments: {
        listForOrder: async () => [],
        commitAttempt: (input) => committed.push(input),
        listReconcilableAttempts: async () => [],
        recordReconciliation: async () => undefined,
        claimReconcileGate: async () => true,
        ...(countAttemptsFromIp === undefined ? {} : { countAttemptsFromIp }),
      },
    },
  };
}

async function newService() {
  return createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    clock: () => 1000,
  });
}

function fakeExpressRequest({ url, body, protocol = "http", ip }) {
  return {
    method: "POST",
    originalUrl: url,
    url,
    protocol,
    ip,
    headers: { host: "shop.example", "content-type": "application/json" },
    body,
  };
}

function fakeExpressResponse() {
  const state = { statusCode: 0, headers: {}, body: undefined };
  return {
    state,
    status(code) {
      state.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      state.headers[key.toLowerCase()] = value;
    },
    send(payload) {
      state.body = payload;
    },
  };
}

// Hosts follow the guides against whatever package they installed, so an
// adapter (and the umbrella subpath over it) must carry the whole
// @openreceive/http surface — not a hand-copied subset that drifts.
test("every adapter and umbrella subpath re-exports the whole @openreceive/http surface", () => {
  const surfaces = [
    ["@openreceive/express", expressAdapter],
    ["@openreceive/fastify", fastifyAdapter],
    ["@openreceive/next", nextAdapter],
    ["openreceive/express", umbrellaExpress],
    ["openreceive/fastify", umbrellaFastify],
    ["openreceive/next", umbrellaNext],
  ];
  const exported = Object.keys(httpSurface);
  assert.ok(exported.includes("startOpenReceiveNotificationWorker"));
  for (const [name, surface] of surfaces) {
    for (const key of exported) {
      assert.ok(key in surface, `${name} must re-export ${key}`);
    }
  }
});

test("express middleware serves its prefix and passes other paths to next()", async () => {
  const service = await newService();
  const { host } = testHost();
  const middleware = openReceiveExpress({ service, authorize: () => true, host });
  assert.equal(middleware.prefix, "/openreceive");

  let nextCalls = 0;
  await middleware(
    fakeExpressRequest({ url: "/shop/cart", body: {} }),
    fakeExpressResponse(),
    () => {
      nextCalls += 1;
    },
  );
  assert.equal(nextCalls, 1);

  const res = fakeExpressResponse();
  await middleware(
    fakeExpressRequest({ url: "/openreceive/checkouts", body: { order_id: "order-ex" } }),
    res,
    () => {
      throw new Error("must not fall through");
    },
  );
  assert.equal(res.state.statusCode, 201);
  const body = JSON.parse(res.state.body);
  assert.equal(body.checkout.order_id, "order-ex");
});

test("a root-mounted express middleware claims only the OpenReceive routes", async () => {
  const service = await newService();
  const { host } = testHost();
  const middleware = openReceiveExpress({ service, authorize: () => true, host, prefix: "/" });

  // Mounted at the root, the library shares the URL space with the host app:
  // everything that is not one of its own routes belongs to the app.
  for (const url of ["/shop/cart", "/", "/checkouts/nope"]) {
    let nextCalls = 0;
    const res = fakeExpressResponse();
    await middleware(fakeExpressRequest({ url, body: {} }), res, () => {
      nextCalls += 1;
    });
    assert.equal(nextCalls, 1, url);
    assert.equal(res.state.statusCode, 0, url);
  }

  const served = fakeExpressResponse();
  await middleware(
    fakeExpressRequest({ url: "/checkouts", body: { order_id: "order-root" } }),
    served,
    () => {
      throw new Error("must not fall through");
    },
  );
  assert.equal(served.state.statusCode, 201);
});

test("a JSON body no parser read names the missing body parser", async () => {
  const service = await newService();
  const { host } = testHost();
  const middleware = openReceiveExpress({ service, authorize: () => true, host });
  const res = fakeExpressResponse();
  await middleware(
    {
      method: "POST",
      originalUrl: "/openreceive/checkouts",
      url: "/openreceive/checkouts",
      protocol: "http",
      // express.json() was never mounted, so req.body is absent while the raw
      // stream still holds the JSON the client sent.
      headers: {
        host: "shop.example",
        "content-type": "application/json",
        "content-length": "27",
      },
    },
    res,
    () => {
      throw new Error("must not fall through");
    },
  );
  assert.equal(res.state.statusCode, 500);
  const body = JSON.parse(res.state.body);
  assert.match(body.message, /body parser/);
  assert.doesNotMatch(body.message, /order_id/);
});

test("express native.ip drives rate limiting through the whole adapter path", async () => {
  const service = await newService();
  const { host } = testHost({ countAttemptsFromIp: () => 999 });
  const middleware = openReceiveExpress({
    service,
    authorize: () => true,
    host,
    rateLimiting: true,
  });
  const res = fakeExpressResponse();
  await middleware(
    fakeExpressRequest({
      url: "/openreceive/checkouts",
      body: { order_id: "order-limited" },
      ip: "203.0.113.9",
    }),
    res,
    () => {
      throw new Error("must not fall through");
    },
  );
  assert.equal(res.state.statusCode, 429);
  assert.ok(Number(res.state.headers["retry-after"]) >= 1);
});

function fakeFastify() {
  const routes = [];
  return {
    routes,
    all(path, handler) {
      routes.push({ path, handler });
    },
  };
}

function fakeFastifyReply() {
  const state = { statusCode: 0, headers: {}, body: undefined, notFound: 0 };
  return {
    state,
    code(statusCode) {
      state.statusCode = statusCode;
      return this;
    },
    header(key, value) {
      state.headers[key.toLowerCase()] = value;
      return this;
    },
    send(payload) {
      state.body = payload;
      return this;
    },
    callNotFound() {
      state.notFound += 1;
    },
  };
}

test("fastify plugin serves its prefix, honors protocol, and never captures the app root", async () => {
  const service = await newService();
  const { host } = testHost();
  const fastify = fakeFastify();
  openReceiveFastify(fastify, { service, authorize: () => true, host });
  assert.equal(fastify.routes.length, 1);
  const route = fastify.routes[0].handler;

  // A non-OpenReceive path goes to the app's own not-found handling.
  const missed = fakeFastifyReply();
  await route(
    {
      method: "GET",
      headers: { host: "shop.example" },
      raw: { url: "/some/other/route" },
    },
    missed,
  );
  assert.equal(missed.state.notFound, 1);
  assert.equal(missed.state.statusCode, 0, "the plugin must not answer foreign paths");

  const served = fakeFastifyReply();
  await route(
    {
      method: "POST",
      headers: { host: "shop.example", "content-type": "application/json" },
      raw: { url: "/openreceive/checkouts" },
      protocol: "https",
      body: { order_id: "order-ff" },
    },
    served,
  );
  assert.equal(served.state.statusCode, 201);
  assert.equal(JSON.parse(served.state.body).checkout.order_id, "order-ff");
});

test("next adapter refuses rateLimiting without an IP source", async () => {
  const service = await newService();
  const { host } = testHost({ countAttemptsFromIp: () => 0 });
  assert.throws(
    () =>
      openReceiveNextHandlers({
        service,
        authorize: () => true,
        host,
        rateLimiting: true,
      }),
    /needs a client IP source/,
  );
});

test("next adapter trustProxyIpHeader reads x-forwarded-for for the limiter", async () => {
  const service = await newService();
  const counted = [];
  const { host } = testHost({
    countAttemptsFromIp: (ip) => {
      counted.push(ip);
      return 999;
    },
  });
  const { POST } = openReceiveNextHandlers({
    service,
    authorize: () => true,
    host,
    rateLimiting: true,
    trustProxyIpHeader: true,
  });
  const response = await POST(
    new Request("http://shop.example/openreceive/checkouts", {
      method: "POST",
      headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1" },
      body: JSON.stringify({ order_id: "order-next" }),
    }),
  );
  assert.equal(response.status, 429);
  assert.deepEqual(counted.slice(0, 1), ["198.51.100.9"]);
});

// --- All-in-one stack form (T1): order hooks + db handle, no prebuilt service/host ---

function stackFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(openReceivePaymentsSchemaSql("sqlite"));
  const orders = new Map([["order-stack", { amount: { sats: 21 } }]]);
  const paid = [];
  return {
    db,
    options: {
      service: newService(),
      db,
      loadOrder: (orderId) => orders.get(orderId) ?? null,
      amountForOrder: (order) => order.amount,
      onPaid: async (settlement) => {
        paid.push(settlement.orderId);
      },
      authorize: () => true,
    },
  };
}

test("express all-in-one form boots lazily and serves a checkout", async () => {
  const { db, options } = stackFixture();
  const middleware = openReceiveExpress(options);
  assert.equal(middleware.prefix, "/openreceive");
  assert.ok(middleware.ready instanceof Promise);
  const res = fakeExpressResponse();
  await middleware(
    fakeExpressRequest({ url: "/openreceive/checkouts", body: { order_id: "order-stack" } }),
    res,
    () => {
      throw new Error("must not fall through");
    },
  );
  assert.equal(res.state.statusCode, 201);
  const row = db.prepare("SELECT order_id FROM openreceive_payments").get();
  assert.equal(row.order_id, "order-stack");
  await middleware.ready;
  await middleware.close();
});

test("the all-in-one form wires a custom repository instead of a db handle", async () => {
  const committed = [];
  const middleware = openReceiveExpress({
    service: newService(),
    payments: {
      listForOrder: async () => [],
      commitAttempt: (input) => committed.push(input),
      listReconcilableAttempts: async () => [],
      recordReconciliation: async () => undefined,
      // The library owns write-once settlement even for custom repositories.
      recordSettlement: async () => true,
    },
    onSettlement: async () => undefined,
    loadOrder: () => ({ amount: { sats: 21 } }),
    amountForOrder: (order) => order.amount,
    authorize: () => true,
    // This repository has no durable gate, so it opts out explicitly.
    opportunisticReconcile: false,
  });
  const res = fakeExpressResponse();
  await middleware(
    fakeExpressRequest({ url: "/openreceive/checkouts", body: { order_id: "order-custom" } }),
    res,
    () => {
      throw new Error("must not fall through");
    },
  );
  assert.equal(res.state.statusCode, 201);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].orderId, "order-custom");
  await middleware.close();
});

test("all-in-one form requires exactly one of nwc or service", () => {
  const { options } = stackFixture();
  assert.throws(
    () => openReceiveExpress({ ...options, service: undefined }),
    /exactly one of nwc or service/,
  );
});

test("next all-in-one form serves requests and exposes ready/close", async () => {
  const { options } = stackFixture();
  const handlers = openReceiveNextHandlers(options);
  const response = await handlers.POST(
    new Request("http://shop.example/openreceive/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_id: "order-stack" }),
    }),
  );
  assert.equal(response.status, 201);
  await handlers.ready;
  await handlers.close();
});

test("all-in-one form starts no background loop; settlement is opportunistic", async () => {
  const { options } = stackFixture();
  // No timer may be left behind: ready resolves, close() only closes the owned
  // service, and the process would exit cleanly (settlement of abandoned
  // checkouts rides on later OpenReceive calls through the durable gate).
  const activeBefore = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const middleware = openReceiveExpress(options);
  await middleware.ready;
  const activeAfter = process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  assert.equal(activeAfter, activeBefore, "stack must not schedule a background reconciler timer");
  await middleware.close();
});
