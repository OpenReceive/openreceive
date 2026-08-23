import assert from "node:assert/strict";
import test from "node:test";
import { memoryPaymentsDb } from "./helpers/factories.mjs";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import {
  createHttpHandler,
  createIpRateLimit,
  createSqlPayments,
  resolveClientIp,
} from "../packages/js/http/src/index.ts";
import {
  OPENRECEIVE_DEFAULT_IP_RATE_LIMIT_PER_HOUR,
  clientIpBucket,
} from "../packages/js/http/src/rate-limit.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

function testHost({ onCheckoutCreated = () => undefined, countAttemptsFromIp } = {}) {
  return {
    resolveCheckout: () => ({ amount: { sats: 1234 } }),
    onCheckoutCreated,
    onPaid: async () => undefined,
    payments: {
      listForReference: async () => [],
      commitAttempt: onCheckoutCreated,
      listReconcilableAttempts: async () => [],
      recordReconciliation: async () => undefined,
      claimReconcileGate: async () => true,
      ...(countAttemptsFromIp === undefined ? {} : { countAttemptsFromIp }),
    },
  };
}

async function newService() {
  return createOpenReceive({
    client: createTestkitReceiveClient({ now: () => 1000 }),
    clock: () => 1000,
  });
}

function createRequest(reference) {
  return new Request("http://test/openreceive/checkouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reference: reference }),
  });
}

test("rate limiting is off by default", async () => {
  const service = await newService();
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: testHost(),
  });
  for (let index = 0; index < 5; index += 1) {
    const response = await handler(createRequest(`order-${index}`), {
      native: { ip: "203.0.113.9" },
    });
    assert.equal(response.status, 201);
  }
});

test("rateLimiting: true counts attempt rows via the repository and returns a payer-facing 429", async () => {
  const service = await newService();
  const counted = [];
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      countAttemptsFromIp: (ip, since) => {
        counted.push({ ip, since });
        return OPENRECEIVE_DEFAULT_IP_RATE_LIMIT_PER_HOUR;
      },
    }),
    rateLimiting: true,
  });
  const response = await handler(createRequest("order-limited"), {
    native: { ip: "203.0.113.9" },
  });
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.equal(body.retryable, true);
  assert.equal(body.message, "Too many payment attempts. Please try again later.");
  assert.equal(counted[0].ip, "203.0.113.9");
  assert.ok(Number.isInteger(counted[0].since));
});

test("rateLimiting refuses to boot without persistent counting", async () => {
  const service = await newService();
  // A custom repository without countAttemptsFromIp cannot back the limiter; the
  // handler must fail construction rather than degrade to per-process memory.
  assert.throws(
    () =>
      createHttpHandler({
        service,
        authorize: () => true,
        host: testHost(),
        rateLimiting: { limitPerHour: 2 },
      }),
    /countAttemptsFromIp/,
  );
});

test("createIpRateLimit requires a counter at construction", () => {
  assert.throws(() => createIpRateLimit(), /countAttemptsFromIp/);
});

test("rateLimiting rejects non-create actions at construction", async () => {
  const service = await newService();
  assert.throws(
    () =>
      createHttpHandler({
        service,
        authorize: () => true,
        host: testHost({ countAttemptsFromIp: () => 0 }),
        rateLimiting: { actions: ["payment.check"] },
      }),
    /invoice-minting actions/,
  );
});

test("a capped payer can still re-fetch an already-committed attempt", async () => {
  const service = await newService();
  const hash = "a".repeat(64);
  const committed = {
    reference: "order-reuse",
    paymentHash: hash,
    bolt11: "lnbc-reuse",
    amountMsats: 1234000,
    createdAt: 900,
    expiresAt: 1500,
    fiatQuote: null,
  };
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: {
      resolveCheckout: () => ({ amount: { sats: 1234 }, paymentHash: hash, checkout: committed }),
      onCheckoutCreated: () => {
        throw new Error("reuse must not mint or commit");
      },
      onPaid: async () => undefined,
      payments: {
        listForReference: async () => [],
        commitAttempt: () => undefined,
        listReconcilableAttempts: async () => [],
        recordReconciliation: async () => undefined,
        claimReconcileGate: async () => true,
        // Counter says this IP is far over any limit; reuse must not consult it.
        countAttemptsFromIp: () => 1_000_000,
      },
    },
    rateLimiting: true,
  });
  const response = await handler(createRequest("order-reuse"), { native: { ip: "203.0.113.9" } });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.checkout.payment_hash, hash);
  assert.equal(body.checkout.bolt11, "lnbc-reuse");
});

test("rateLimiting fails open when no client IP is attributable", async () => {
  const service = await newService();
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      countAttemptsFromIp: () => {
        throw new Error("must not count without an IP");
      },
    }),
    rateLimiting: { limitPerHour: 1 },
  });
  const noNative = await handler(createRequest("order-open-1"));
  const emptyIp = await handler(createRequest("order-open-2"), { native: { ip: "" } });
  assert.equal(noNative.status, 201);
  assert.equal(emptyIp.status, 201);
});

test("rateLimiting does not throttle non-create actions", async () => {
  const service = await newService();
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: testHost({ countAttemptsFromIp: () => 1_000_000 }),
    rateLimiting: true,
  });
  const prepared = await handler(
    new Request("http://test/openreceive/checkouts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reference: "order-prepare" }),
    }),
    { native: { ip: "203.0.113.9" } },
  );
  assert.equal(prepared.status, 200);
});

test("rateLimiting and a custom rateLimitHook are mutually exclusive", async () => {
  const service = await newService();
  assert.throws(
    () =>
      createHttpHandler({
        service,
        authorize: () => true,
        host: testHost(),
        rateLimiting: true,
        rateLimitHook: () => true,
      }),
    /either rateLimiting or a custom rateLimitHook/,
  );
});

test("checkout create stores the client IP on the attempt row", async () => {
  const service = await newService();
  const db = memoryPaymentsDb();
  const payments = createSqlPayments(db, { clock: () => 1000 });
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: {
      resolveCheckout: () => ({ amount: { sats: 1234 } }),
      onCheckoutCreated: (input) => payments.commitAttempt(input),
      onPaid: async () => undefined,
      payments,
    },
    rateLimiting: true,
  });
  const created = await handler(createRequest("order-ip"), { native: { ip: "203.0.113.9" } });
  assert.equal(created.status, 201);
  const row = db
    .prepare("SELECT client_ip FROM openreceive_payments WHERE reference = ?")
    .get("order-ip");
  assert.equal(row.client_ip, "203.0.113.9");
  assert.equal(await payments.countAttemptsFromIp("203.0.113.9", 0), 1);
  assert.equal(await payments.countAttemptsFromIp("203.0.113.9", 2000), 0);
  assert.equal(await payments.countAttemptsFromIp("198.51.100.7", 0), 0);

  // A row without an attributable IP stays null and is never counted.
  const anonymous = await handler(createRequest("order-anon"));
  assert.equal(anonymous.status, 201);
  const anonymousRow = db
    .prepare("SELECT client_ip FROM openreceive_payments WHERE reference = ?")
    .get("order-anon");
  assert.equal(anonymousRow.client_ip, null);
});

test("createIpRateLimit enforces hourly and daily windows against the counter", async () => {
  const seen = [];
  const limiter = createIpRateLimit({
    limitPerHour: 2,
    limitPerDay: 3,
    now: () => 100_000,
    countAttemptsFromIp: (_ip, since) => {
      seen.push(since);
      // 1 attempt in the last hour, 3 in the last day.
      return since === 100_000 - 3_600 ? 1 : 3;
    },
  });
  const context = { action: "checkout.create", native: { ip: "203.0.113.9" } };
  await assert.rejects(
    () => Promise.resolve(limiter(context)),
    (error) => {
      assert.equal(error.status, 429);
      assert.equal(error.code, "RATE_LIMITED");
      return true;
    },
  );
  assert.deepEqual(seen, [100_000 - 3_600, 100_000 - 86_400]);
});

test("resolveClientIp reads the adapter request IP and tolerates anything else", () => {
  assert.equal(resolveClientIp({ native: { ip: "203.0.113.9" } }), "203.0.113.9");
  assert.equal(resolveClientIp({ native: { ip: 42 } }), undefined);
  assert.equal(resolveClientIp({ native: undefined }), undefined);
  assert.equal(resolveClientIp({}), undefined);
});

test("a custom ip extractor both counts and stamps the same IP (SQL counting)", async () => {
  const db = memoryPaymentsDb();
  const payments = createSqlPayments(db, { clock: () => 1000 });
  const service = await newService();
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: {
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: (input) => payments.commitAttempt(input),
      onPaid: async () => undefined,
      payments,
    },
    rateLimiting: {
      limitPerHour: 2,
      now: () => 1000,
      ip: (context) => context.request.headers.get("cf-connecting-ip") ?? undefined,
    },
  });
  const post = (reference) =>
    handler(
      new Request("http://test/openreceive/checkouts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.7",
        },
        body: JSON.stringify({ reference: reference }),
      }),
    );
  assert.equal((await post("order-x1")).status, 201);
  assert.equal((await post("order-x2")).status, 201);
  // The extractor's IP must be what was stored, so the COUNT sees both rows.
  const rows = db.prepare("SELECT client_ip FROM openreceive_payments").all();
  assert.deepEqual(
    rows.map((row) => row.client_ip),
    ["198.51.100.7", "198.51.100.7"],
  );
  const capped = await post("order-x3");
  assert.equal(capped.status, 429);
});

test("429 responses carry a Retry-After header", async () => {
  const service = await newService();
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: testHost({ countAttemptsFromIp: () => 999 }),
    rateLimiting: true,
  });
  const response = await handler(createRequest("order-retry-after"), {
    native: { ip: "203.0.113.20" },
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
  const body = await response.json();
  assert.equal(body.retryable, true);
});

test("rateLimiting: false composes with a custom rateLimitHook", async () => {
  const service = await newService();
  const handler = createHttpHandler({
    service,
    authorize: () => true,
    host: testHost(),
    rateLimiting: false,
    rateLimitHook: () => false,
  });
  const response = await handler(createRequest("order-hook"), {
    native: { ip: "203.0.113.21" },
  });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("retry-after")) >= 1);
});

test("clientIpBucket collapses v4-mapped and buckets IPv6 by /64", () => {
  assert.equal(clientIpBucket("203.0.113.9"), "203.0.113.9");
  assert.equal(clientIpBucket("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientIpBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  // Rotating privacy addresses inside one /64 share a single budget.
  assert.equal(
    clientIpBucket("2001:db8:1:2:1111:2222:3333:4444"),
    clientIpBucket("2001:db8:1:2:aaaa:bbbb:cccc:dddd"),
  );
  assert.equal(clientIpBucket("2001:db8::1"), "2001:db8:0:0::/64");
  // Idempotent: bucketing a bucket changes nothing.
  assert.equal(clientIpBucket("2001:db8:1:2::/64"), "2001:db8:1:2::/64");
  // Unparsable input passes through so the limit still gets a consistent key.
  assert.equal(clientIpBucket("not-an-ip:zz"), "not-an-ip:zz");
});
