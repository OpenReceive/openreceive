import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { OpenReceiveError } from "../packages/js/core/src/index.ts";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import {
  createOpenReceiveHttpHandler,
  createOpenReceiveHost,
  hostError,
} from "../packages/js/http/src/index.ts";
import { openReceivePaymentInsert } from "../packages/js/http/src/payment-repository.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../packages/js/testkit/src/index.ts";

function testHost({
  resolveCheckout,
  onCheckoutCreated,
  onPaid = async () => undefined,
  seededAttempts = [],
}) {
  // Minimal in-memory repository: committed attempts stay pending, so the
  // handler's default opportunistic reconcile (and payments/check) sees them.
  const attempts = [...seededAttempts];
  const record = async (input) => {
    const result = await onCheckoutCreated(input);
    attempts.push(input);
    return result;
  };
  return {
    resolveCheckout,
    onCheckoutCreated: record,
    onPaid,
    payments: {
      listForOrder: async (orderId) =>
        attempts
          .filter((input) => input.orderId === orderId)
          .map((input) => ({
            orderId: input.orderId,
            paymentHash: input.paymentHash.toLowerCase(),
            status: "pending",
            statusReason: null,
            paidAt: null,
            expiresAt: input.checkout.expiresAt,
            createdAt: input.checkout.createdAt,
            checkout: input.checkout,
            ...(input.swapData === undefined ? {} : { swapData: input.swapData }),
          })),
      commitAttempt: record,
      listReconcilableAttempts: async () =>
        attempts.map((input) => ({
          paymentHash: input.paymentHash.toLowerCase(),
          createdAt: input.checkout.createdAt,
          expiresAt: input.checkout.expiresAt,
        })),
      recordReconciliation: async () => undefined,
      // The library owns write-once settlement even for custom repositories:
      // this claim is what decides whether repository-mode onPaid runs.
      recordSettlement: async () => true,
      claimReconcileGate: async () => true,
    },
  };
}

// @openreceive/http may own the payment-attempt rows, but only through a
// host-supplied database handle: no separate database URL, Redis, or migration
// runner, and no bundled driver — the pg / SQLite adapters are duck-typed.
test("@openreceive/http never opens its own database connection or reads storage env", () => {
  const sourceDir = "packages/js/http/src";
  for (const filename of readdirSync(sourceDir).filter((name) => name.endsWith(".ts"))) {
    const source = readFileSync(`${sourceDir}/${filename}`, "utf8");
    assert.doesNotMatch(
      source,
      /from\s+["'](?:pg|better-sqlite3|node:sqlite|sqlite3|ioredis|redis|knex)["']/,
      `${filename} must not import a database driver at module scope`,
    );
    assert.doesNotMatch(
      source,
      /require\(\s*["'](?:pg|better-sqlite3|node:sqlite|sqlite3|ioredis|redis|knex)["']\s*\)/,
      `${filename} must not require a database driver`,
    );
    assert.doesNotMatch(
      source,
      /import\(\s*["'](?:pg|better-sqlite3|node:sqlite)["']\s*\)/,
      `${filename} must not dynamically import a database driver`,
    );
    assert.doesNotMatch(
      source,
      /DATABASE_URL|REDIS_URL|POSTGRES_URL/,
      `${filename} must not read a storage connection URL`,
    );
    assert.doesNotMatch(
      source,
      /process\.env/,
      `${filename} must not read environment configuration`,
    );
  }
});

test("@openreceive/http declares no database, Redis, or migration-runner dependency", () => {
  const manifest = JSON.parse(readFileSync("packages/js/http/package.json", "utf8"));
  const banned = /^(pg|pg-.*|better-sqlite3|sqlite3|redis|ioredis|knex|typeorm|prisma|.*-migrate)$/;
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      assert.doesNotMatch(name, banned, `${section} must not include ${name}`);
    }
  }
});

// B10: handler.ts hand-mirrors each route's `additionalProperties: false` field
// list from the OpenAPI request schemas. Nothing but review catches a drift
// between the two, so pin them against each other here: a field added to the
// contract but not to the handler would be rejected as "unexpected"; a field
// added to the handler but not to the contract would be silently accepted.
const SPEC_ROUTE_KINDS = {
  prepareCheckout: "checkout.prepare",
  createCheckout: "checkout.create",
  checkPayment: "payment.check",
  quoteSwap: "swap.quote",
  createSwap: "swap.create",
  getSwap: "swap.read",
  refundSwap: "swap.refund",
};

/** The module-private ROUTE_BODY_FIELDS table, read from http-request.ts source. */
function handlerRouteBodyFields() {
  const source = readFileSync("packages/js/http/src/http-request.ts", "utf8");
  const table =
    /const ROUTE_BODY_FIELDS: Record<string, readonly string\[\]> = \{([\s\S]*?)\n\};/.exec(source);
  assert.ok(table !== null, "http-request.ts must declare ROUTE_BODY_FIELDS");
  const fields = {};
  for (const [, kind, list] of table[1].matchAll(/"([\w.]+)":\s*\[([^\]]*)\]/g)) {
    fields[kind] = [...list.matchAll(/"([^"]+)"/g)].map(([, name]) => name);
  }
  return fields;
}

test("the handler's per-route field whitelist matches the OpenAPI request schemas", () => {
  const spec = parseYaml(readFileSync("spec/openapi/openreceive-http.v1.yaml", "utf8"));
  const fields = handlerRouteBodyFields();
  const seen = [];
  for (const operation of Object.values(spec.paths)) {
    const post = operation.post;
    if (post === undefined) continue;
    const routeKind = SPEC_ROUTE_KINDS[post.operationId];
    assert.ok(
      routeKind !== undefined,
      `${post.operationId}: add it to SPEC_ROUTE_KINDS and to http-request.ts's ROUTE_BODY_FIELDS`,
    );
    seen.push(routeKind);
    let schema = post.requestBody.content["application/json"].schema;
    if (schema.$ref !== undefined) {
      schema = spec.components.schemas[schema.$ref.replace("#/components/schemas/", "")];
    }
    assert.equal(
      schema.additionalProperties,
      false,
      `${post.operationId}: the request schema must close its field list`,
    );
    assert.deepEqual(
      [...(fields[routeKind] ?? [])].sort(),
      Object.keys(schema.properties).sort(),
      `${post.operationId}: http-request.ts ROUTE_BODY_FIELDS["${routeKind}"] drifted from the contract`,
    );
  }
  assert.deepEqual(
    Object.keys(fields).sort(),
    seen.sort(),
    "ROUTE_BODY_FIELDS must name exactly the spec's POST routes",
  );
});

test("HTTP commits payment hash before returning payer instructions", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const paid = [];
  const service = await createOpenReceive({
    client: wallet,
    clock: () => 1000,
  });
  const committed = [];
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({
        amount: { sats: 1234 },
        ...(committed[0] === undefined
          ? {}
          : {
              paymentHash: committed[0].paymentHash,
              checkout: committed[0].checkout,
            }),
      }),
      onCheckoutCreated: (payment) => committed.push(payment),
      onPaid: (payment) => paid.push(payment),
    }),
  });
  const created = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_id: "order-http" }),
    }),
  );
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(committed[0].paymentHash, body.checkout.payment_hash);
  assert.equal(body.order_access_token, undefined);

  wallet.settleInvoice({ payment_hash: body.checkout.payment_hash }, { settled_at: 1010 });
  const checked = await handler(
    new Request("http://test/openreceive/payments/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order_id: "order-http",
        payment_hash: body.checkout.payment_hash,
      }),
    }),
  );
  assert.equal(checked.status, 200);
  const checkedBody = await checked.json();
  assert.equal(checkedBody.status, "settled");
  assert.deepEqual(checkedBody.payment_methods, []);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].paymentHash, body.checkout.payment_hash);
  // The payer-polled response must never leak wallet secrets from the
  // settlement details (preimage, raw invoice, wallet metadata) — while still
  // carrying the public amount fields the whitelist exists to expose. The
  // details must be PRESENT for these leak checks to mean anything: a refactor
  // that drops `details` would otherwise turn this block green-and-empty.
  assert.ok(
    checkedBody.details !== undefined,
    "the settled payments/check body must carry details for the leak checks to run",
  );
  const transaction = checkedBody.details.transaction ?? {};
  assert.equal(transaction.preimage, undefined);
  assert.equal(transaction.invoice, undefined);
  assert.equal(transaction.metadata, undefined);
  assert.equal(transaction.amount_msats, 1_234_000);
});

test("HTTP prepare locks amount without minting or committing an attempt", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    clock: () => 1000,
  });
  const committed = [];
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1234 } }),
      onCheckoutCreated: (payment) => committed.push(payment),
    }),
  });
  const prepared = await handler(
    new Request("http://test/openreceive/checkouts/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ order_id: "order-prepare" }),
    }),
  );
  assert.equal(prepared.status, 200);
  const body = await prepared.json();
  assert.equal(body.order_id, "order-prepare");
  assert.equal(body.amount_msats, 1_234_000);
  assert.ok(Array.isArray(body.payment_methods));
  assert.equal(body.bolt11, undefined);
  assert.equal(body.payment_hash, undefined);
  assert.equal(committed.length, 0);
});

test("HTTP withholds invoice when host persistence fails", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {
        throw new Error("database unavailable");
      },
    }),
  });
  const response = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-fail" }),
    }),
  );
  // Infrastructure failure to persist is a retryable 503, not a payer-blaming
  // conflict; the invoice is still withheld.
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.checkout, undefined);
  assert.equal(body.code, "INTERNAL");
  assert.equal(body.retryable, true);
});

test("HTTP retry reuses the live checkout recorded on the host order", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    clock: () => 1000,
  });
  let committed;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({
        amount: { sats: 10 },
        ...(committed === undefined
          ? {}
          : { paymentHash: committed.paymentHash, checkout: committed.checkout }),
      }),
      onCheckoutCreated: (payment) => {
        committed = payment;
      },
    }),
  });
  const request = () =>
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "retry-order" }),
    });
  const first = await handler(request());
  const second = await handler(request());
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(
    (await first.json()).checkout.payment_hash,
    (await second.json()).checkout.payment_hash,
  );
  assert.equal(
    (await wallet.listTransactions({ type: "incoming", unpaid: true, limit: 20 })).transactions
      .length,
    1,
  );
});

test("host checkout snapshot makes retry independent of wallet reads", async () => {
  const wallet = createTestkitReceiveClient();
  const service = await createOpenReceive({ client: wallet });
  const rows = [];
  const host = createOpenReceiveHost({
    clock: () => 1000,
    loadOrder: () => ({ total: 10 }),
    amountForOrder: () => ({ sats: 10 }),
    payments: {
      listForOrder: async () => rows,
      commitAttempt: (input) => {
        rows.push({
          ...openReceivePaymentInsert(input),
          status: "pending",
          statusReason: null,
          paidAt: null,
        });
      },
      listReconcilableAttempts: async () => [],
      recordReconciliation: async () => undefined,
      recordSettlement: async () => true,
    },
    onPaid: async () => undefined,
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host,
    // This custom repository has no durable gate; the option documents the
    // explicit opt-out a gate-less repository must make.
    opportunisticReconcile: false,
  });
  const request = () =>
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "snapshot-order" }),
    });
  const first = await handler(request());
  wallet.listTransactions = async () => {
    throw new Error("wallet unavailable");
  };
  const second = await handler(request());
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), await first.json());
});

test("concurrent host-row loser receives no payer instructions", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
  });
  let committed;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 2 } }),
      onCheckoutCreated: ({ paymentHash }) => {
        // Real repositories refuse the loser with a meaningful conflict; the
        // handler must pass that through untouched.
        if (committed !== undefined && committed !== paymentHash)
          throw hostError(
            "This order already has a live payment attempt for the same method.",
            409,
            "CONFLICT",
          );
        committed = paymentHash;
      },
    }),
  });
  const responses = await Promise.all(
    [1, 2].map(() =>
      handler(
        new Request("http://test/openreceive/checkouts", {
          method: "POST",
          body: JSON.stringify({ order_id: "concurrent-order" }),
        }),
      ),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const loser = await responses.find((response) => response.status === 409).json();
  assert.equal(loser.checkout, undefined);
  assert.match(loser.message, /live payment attempt/);
});

test("HTTP payment check includes swap payment_methods from the provider catalog", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const provider = createTestkitSwapProvider({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    swap: { provider },
    clock: () => 1000,
  });
  let committed;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({
        amount: { sats: 20_000 },
        ...(committed === undefined
          ? {}
          : {
              paymentHash: committed.paymentHash,
              checkout: committed.checkout,
            }),
      }),
      onCheckoutCreated: (payment) => {
        committed = payment;
      },
    }),
  });
  const created = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-methods" }),
    }),
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  const checked = await handler(
    new Request("http://test/openreceive/payments/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order_id: "order-methods",
        payment_hash: createdBody.checkout.payment_hash,
      }),
    }),
  );
  assert.equal(checked.status, 200);
  const checkedBody = await checked.json();
  assert.equal(checkedBody.status, "pending");
  assert.ok(Array.isArray(checkedBody.payment_methods));
  assert.ok(checkedBody.payment_methods.length > 0);
  assert.ok(
    checkedBody.payment_methods.some(
      (method) => method.pay_in_asset === "USDT_TRON" && method.provider === "fixedfloat",
    ),
  );
  assert.equal(provider.catalogCalls, 1);

  // Polls inside the warm window serve the cached catalog: a ~3s status poll
  // must not re-walk the provider catalog every time.
  const polled = await handler(
    new Request("http://test/openreceive/payments/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        order_id: "order-methods",
        payment_hash: createdBody.checkout.payment_hash,
      }),
    }),
  );
  assert.equal(polled.status, 200);
  const polledBody = await polled.json();
  assert.ok(polledBody.payment_methods.length > 0, "cached payment_methods stay present");
  assert.equal(provider.catalogCalls, 1, "a repeat poll must not re-walk the catalog");
});

test("HTTP swap retry reuses host-committed hash/data without exposing provider state", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const provider = createTestkitSwapProvider({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    swap: { provider },
    clock: () => 1000,
  });
  let hostPaymentHash;
  let hostSwapData;
  let hostCheckout;
  let commits = 0;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({
        amount: { sats: 20_000 },
        ...(hostPaymentHash === undefined
          ? {}
          : {
              paymentHash: hostPaymentHash,
              checkout: hostCheckout,
            }),
        ...(hostSwapData === undefined ? {} : { swapData: hostSwapData }),
      }),
      onCheckoutCreated: ({ paymentHash, checkout, swapData }) => {
        commits += 1;
        hostPaymentHash = paymentHash;
        hostCheckout = JSON.parse(JSON.stringify(checkout));
        hostSwapData = JSON.parse(JSON.stringify(swapData));
      },
    }),
  });
  const request = () =>
    new Request("http://test/openreceive/swaps", {
      method: "POST",
      body: JSON.stringify({ order_id: "swap-http", pay_in_asset: "USDT_TRON" }),
    });
  const first = await handler(request());
  const second = await handler(request());
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const firstBody = await first.json();
  const secondBody = await second.json();
  assert.equal(firstBody.swap.payment_hash, hostPaymentHash);
  assert.equal(firstBody.swap.swap_data, undefined);
  assert.doesNotMatch(JSON.stringify(firstBody), /testkit-token/);
  assert.equal(secondBody.swap.payment_hash, hostPaymentHash);
  assert.equal(commits, 1);
  assert.equal(
    (await wallet.listTransactions({ type: "incoming", unpaid: true, limit: 20 })).transactions
      .length,
    1,
  );

  provider.forceRefundRequired({ providerOrderId: "testkit-swap-1" });
  const statusResponse = await handler(
    new Request("http://test/openreceive/swaps/status", {
      method: "POST",
      body: JSON.stringify({ order_id: "swap-http", payment_hash: hostPaymentHash }),
    }),
  );
  assert.equal(statusResponse.status, 200);
  assert.equal((await statusResponse.json()).provider_state, "refund_required");

  const refundResponse = await handler(
    new Request("http://test/openreceive/swaps/refunds", {
      method: "POST",
      body: JSON.stringify({
        order_id: "swap-http",
        payment_hash: hostPaymentHash,
        refund_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      }),
    }),
  );
  assert.equal(refundResponse.status, 200);
  const refundBody = await refundResponse.json();
  assert.equal(refundBody.provider_state, "refund_pending");
  assert.equal(refundBody.swap_data, undefined);
});

// Full-body golden comparison (schema_version 2). Placeholder strings in a
// vector's expected body/headers assert "present and matching this pattern"
// for values that legitimately differ per run; everything else — key set AND
// values — must match exactly in both engines. Mirrored in
// packages/ruby/openreceive-server/test/server_test.rb; change both together.
const GOLDEN_PLACEHOLDERS = {
  "<request_id>": (value) =>
    typeof value === "string" &&
    /^req_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value),
  "<payment_hash>": (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
  "<bolt11>": (value) => typeof value === "string" && value.startsWith("ln"),
  "<unix_seconds>": (value) => Number.isInteger(value) && value >= 0,
};

function assertGoldenValue(actual, expected, context) {
  if (typeof expected === "string" && expected in GOLDEN_PLACEHOLDERS) {
    assert.ok(
      GOLDEN_PLACEHOLDERS[expected](actual),
      `${context}: ${JSON.stringify(actual)} does not satisfy ${expected}`,
    );
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${context}: expected an array`);
    assert.equal(actual.length, expected.length, `${context}: array length`);
    expected.forEach((item, index) => {
      assertGoldenValue(actual[index], item, `${context}[${index}]`);
    });
    return;
  }
  if (expected !== null && typeof expected === "object") {
    assert.ok(
      actual !== null && typeof actual === "object" && !Array.isArray(actual),
      `${context}: expected an object`,
    );
    assert.deepEqual(
      Object.keys(actual).sort(),
      Object.keys(expected).sort(),
      `${context}: key set`,
    );
    for (const [key, item] of Object.entries(expected)) {
      assertGoldenValue(actual[key], item, `${context}.${key}`);
    }
    return;
  }
  assert.deepEqual(actual, expected, `${context}: value`);
}

// Deterministic settled attempt behind the settled_check golden vector: the
// wallet reports one settled transaction that deliberately carries the
// preimage and raw invoice, and the vector's exact key-set assertion proves
// neither engine leaks them into the payer-polled body.
const SETTLED_GOLDEN_HASH = "7f".repeat(32);
const SETTLED_GOLDEN_TRANSACTION = {
  type: "incoming",
  invoice: "lnbcgoldensettled",
  payment_hash: SETTLED_GOLDEN_HASH,
  amount_msats: 1000n,
  transaction_state: "settled",
  created_at: 900,
  expires_at: 1500,
  settled_at: 950,
  preimage: "1".repeat(64),
};
const SETTLED_GOLDEN_CHECKOUT = {
  orderId: "order-golden-settled",
  paymentHash: SETTLED_GOLDEN_HASH,
  bolt11: "lnbcgoldensettled",
  amountMsats: 1000,
  createdAt: 900,
  expiresAt: 1500,
  fiatQuote: null,
};

test("Node handler satisfies host-persistence HTTP golden vectors", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
  });
  const host = testHost({
    resolveCheckout: () => ({ amount: { sats: 1 } }),
    onCheckoutCreated: () => {},
  });
  const settledService = await createOpenReceive({
    client: {
      preflight: async () => ({
        walletPubkey: "f".repeat(64),
        relays: [],
        methods: ["make_invoice", "list_transactions"],
        encryption: "nip04",
        spendCapabilityAdvertised: false,
        receiveCheckoutReady: true,
        warnings: [],
      }),
      makeInvoice: async () => {
        throw new Error("the settled_check golden handler mints nothing");
      },
      listTransactions: async () => ({ transactions: [SETTLED_GOLDEN_TRANSACTION] }),
    },
    clock: () => 1000,
  });
  const handlers = {
    default: createOpenReceiveHttpHandler({ service, authorize: () => true, host }),
    // A hook that always refuses models a payer over the budget.
    rate_limited: createOpenReceiveHttpHandler({
      service,
      authorize: () => true,
      host,
      rateLimitHook: () => false,
    }),
    settled_check: createOpenReceiveHttpHandler({
      service: settledService,
      authorize: () => true,
      host: testHost({
        resolveCheckout: () => ({
          amount: { sats: 1 },
          paymentHash: SETTLED_GOLDEN_HASH,
          checkout: SETTLED_GOLDEN_CHECKOUT,
        }),
        onCheckoutCreated: () => {},
        // The pending attempt the request-level gated pass scans; the vector's
        // settled body is served from that pass result.
        seededAttempts: [
          {
            orderId: "order-golden-settled",
            paymentHash: SETTLED_GOLDEN_HASH,
            checkout: SETTLED_GOLDEN_CHECKOUT,
          },
        ],
      }),
    }),
  };
  for (const filename of readdirSync("spec/test-vectors/http-golden").sort()) {
    const vector = JSON.parse(readFileSync(`spec/test-vectors/http-golden/${filename}`, "utf8"));
    assert.equal(vector.schema_version, 2, `${filename}: schema_version`);
    const handlerName = vector.handler ?? "default";
    const handler = handlers[handlerName];
    assert.ok(handler !== undefined, `${filename}: no golden handler named "${handlerName}"`);
    const response = await handler(
      new Request(`http://test${vector.request.path}`, {
        method: vector.request.method,
        // `body_bytes` synthesizes an oversized raw body so the vector does not
        // have to inline 64KB of JSON.
        ...(vector.request.body_bytes === undefined
          ? {}
          : { body: "x".repeat(vector.request.body_bytes) }),
        ...(vector.request.body === undefined ? {} : { body: JSON.stringify(vector.request.body) }),
      }),
    );
    assert.equal(response.status, vector.expected.status, vector.name);
    for (const [name, value] of Object.entries(vector.expected.headers ?? {})) {
      assertGoldenValue(response.headers.get(name), value, `${vector.name}: header ${name}`);
    }
    // The whole wire body, not a code sample: an extra or missing field in
    // either engine fails the run.
    assertGoldenValue(await response.json(), vector.expected.body, `${vector.name}: body`);
  }
});

test("a host resolver returning a malformed payment hash is a 500 host bug, not a payer 400", async () => {
  const service = await createOpenReceive({ client: createTestkitReceiveClient() });
  for (const hostHash of [undefined, "not-a-hash"]) {
    const handler = createOpenReceiveHttpHandler({
      service,
      authorize: () => true,
      host: testHost({
        resolveCheckout: () => ({
          amount: { sats: 1 },
          ...(hostHash === undefined ? {} : { paymentHash: hostHash }),
        }),
        onCheckoutCreated: () => {},
      }),
    });
    const response = await handler(
      new Request("http://test/openreceive/payments/check", {
        method: "POST",
        body: JSON.stringify({ order_id: "order-host-bug", payment_hash: "c".repeat(64) }),
      }),
    );
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.code, "INTERNAL");
    assert.match(body.message, /host resolver/);
  }
});

test("handler extras.native reaches the authorize context", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
  });
  const contexts = [];
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: (context) => {
      contexts.push(context);
      return true;
    },
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  const native = { session: { userId: "user-7" } };
  const response = await handler(
    new Request("http://test/openreceive/checkouts/prepare", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-native" }),
    }),
    { native },
  );
  assert.equal(response.status, 200);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].native, native);
  assert.equal(contexts[0].action, "checkout.prepare");
});

test("handler called without extras leaves the authorize context native undefined", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
  });
  const contexts = [];
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: (context) => {
      contexts.push(context);
      return true;
    },
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  const response = await handler(
    new Request("http://test/openreceive/checkouts/prepare", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-no-native" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].native, undefined);
});

test("the wire contract is snake_case only: camelCase aliases are rejected", async () => {
  const service = await createOpenReceive({ client: createTestkitReceiveClient() });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  const response = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ orderId: "order-camel" }),
    }),
  );
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "INVALID_REQUEST");
  assert.match(body.message, /Unexpected request field|order_id is required/);
});

test("undeclared request fields are rejected, including payment_hash on create", async () => {
  const service = await createOpenReceive({ client: createTestkitReceiveClient() });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  // The create schemas are additionalProperties: false; the old off-contract
  // payment_hash selector bypassed the paid/expired guards (H7).
  const hinted = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-hint", payment_hash: "a".repeat(64) }),
    }),
  );
  assert.equal(hinted.status, 400);
  const stray = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-stray", description_hash: "b".repeat(64) }),
    }),
  );
  assert.equal(stray.status, 400);
});

test("declared length caps are enforced (order_id 200, memo 500)", async () => {
  const service = await createOpenReceive({ client: createTestkitReceiveClient() });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  const longOrder = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "x".repeat(201) }),
    }),
  );
  assert.equal(longOrder.status, 400);
  const longMemo = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-memo", memo: "m".repeat(501) }),
    }),
  );
  assert.equal(longMemo.status, 400);
});

test("oversized request bodies are rejected 413 before authorize runs", async () => {
  const service = await createOpenReceive({ client: createTestkitReceiveClient() });
  let authorized = 0;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => {
      authorized += 1;
      return true;
    },
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  const response = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-big", metadata: { pad: "x".repeat(70_000) } }),
    }),
  );
  assert.equal(response.status, 413);
  assert.equal(authorized, 0);
});

test("create routes reject payer-supplied amounts", async () => {
  const service = await createOpenReceive({ client: createTestkitReceiveClient() });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  for (const body of [
    { order_id: "order-amount", amount: { sats: 1 } },
    { order_id: "order-amount", amount_msats: 1000 },
  ]) {
    const response = await handler(
      new Request("http://test/openreceive/checkouts", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    assert.equal(response.status, 400);
    // The payer-amount refusal runs before the generic field whitelist, so the
    // client is told what is actually wrong.
    assert.equal(
      (await response.json()).message,
      "This route does not accept a payer-supplied amount; the host resolves its order price.",
    );
  }
});

test("a chunked body is capped mid-stream, before authorize and before it is buffered", async () => {
  const service = await createOpenReceive({ client: createTestkitReceiveClient() });
  let authorized = 0;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => {
      authorized += 1;
      return true;
    },
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  // A chunked upload declares no content-length, so only a running byte cap on
  // the stream itself can stop an unauthenticated payer filling memory.
  let produced = 0;
  const chunk = new TextEncoder().encode("x".repeat(8 * 1024));
  const body = new ReadableStream({
    pull(controller) {
      produced += 1;
      if (produced > 500) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
  const response = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    }),
  );
  assert.equal(response.status, 413);
  assert.equal(authorized, 0);
  assert.ok(produced <= 16, `expected the read to stop at the cap, got ${produced} chunks`);
});

test("wallet failures keep their code and map to 502/503, never a generic 500", async () => {
  const cases = [
    { code: "WALLET_UNAVAILABLE", retryable: true, status: 503 },
    { code: "RESTRICTED", retryable: false, status: 502 },
  ];
  for (const expected of cases) {
    const wallet = createTestkitReceiveClient({ now: () => 1000 });
    const service = await createOpenReceive({ client: wallet, clock: () => 1000 });
    wallet.makeInvoice = async () => {
      throw new OpenReceiveError({
        code: expected.code,
        message: "NWC wallet service is unavailable.",
        retryable: expected.retryable,
      });
    };
    const handler = createOpenReceiveHttpHandler({
      service,
      authorize: () => true,
      host: testHost({
        resolveCheckout: () => ({ amount: { sats: 1 } }),
        onCheckoutCreated: () => {},
      }),
    });
    const response = await handler(
      new Request("http://test/openreceive/checkouts", {
        method: "POST",
        body: JSON.stringify({ order_id: "order-outage" }),
      }),
    );
    assert.equal(response.status, expected.status);
    const body = await response.json();
    assert.equal(body.code, expected.code);
    assert.equal(body.retryable, expected.retryable);
  }
});

test("GET /rates rejects malformed currencies as input, not as a rates outage", async () => {
  const service = await createOpenReceive({ client: createTestkitReceiveClient() });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    host: testHost({
      resolveCheckout: () => ({ amount: { sats: 1 } }),
      onCheckoutCreated: () => {},
    }),
  });
  for (const query of ["?currencies=", "?currencies=,,", "?currencies=US%20Dollar"]) {
    const response = await handler(new Request(`http://test/openreceive/rates${query}`));
    assert.equal(response.status, 400, query);
    const body = await response.json();
    assert.equal(body.code, "INVALID_REQUEST");
    assert.equal(body.retryable, undefined);
  }
});

test("a wallet that ignores unpaid:true never flaps a live attempt to not_found", async () => {
  const now = 1_700_000_000;
  const checkout = {
    orderId: "order-flap",
    paymentHash: "ab".repeat(32),
    bolt11: "lnbcflap",
    amountMsats: 1000,
    createdAt: now,
    expiresAt: now + 600,
    fiatQuote: null,
  };
  const service = await createOpenReceive({
    client: {
      preflight: async () => ({
        walletPubkey: "f".repeat(64),
        relays: [],
        methods: ["make_invoice", "list_transactions"],
        encryption: "nip04",
        spendCapabilityAdvertised: false,
        receiveCheckoutReady: true,
        warnings: [],
      }),
      makeInvoice: async () => {
        throw new Error("this handler mints nothing");
      },
      // Wallets that ignore `unpaid: true` list no live invoice at all, so the
      // scan reports not_found for an attempt that is genuinely pending.
      listTransactions: async () => ({ transactions: [] }),
    },
    clock: () => now,
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    clock: () => now,
    host: testHost({
      resolveCheckout: () => ({
        amount: { sats: 1 },
        paymentHash: checkout.paymentHash,
        checkout,
      }),
      onCheckoutCreated: () => {},
      seededAttempts: [{ orderId: checkout.orderId, paymentHash: checkout.paymentHash, checkout }],
    }),
  });
  const response = await handler(
    new Request("http://test/openreceive/payments/check", {
      method: "POST",
      body: JSON.stringify({
        order_id: checkout.orderId,
        payment_hash: checkout.paymentHash,
      }),
    }),
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  // The committed row is the durable truth; the request that won the gate must
  // report the same status as the ones served from the row.
  assert.equal(body.status, "pending");
});
