import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import { createOpenReceiveHttpHandler } from "../../packages/js/http/src/index.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../../packages/js/testkit/src/index.ts";

const key = Buffer.alloc(32, 9).toString("base64url");

test("HTTP commits payment hash before returning payer instructions", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    tokenKeys: [{ id: "k1", key }],
    clock: () => 1000,
    configPath: false,
  });
  const committed = [];
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: (context) => context.action === "checkout.create" || context.tokenValid,
    resolveCheckoutAmount: () => ({ sats: 1234 }),
    onCheckoutCreated: (payment) => committed.push(payment),
  });
  const created = await handler(new Request("http://test/openreceive/checkouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order_id: "order-http" }),
  }));
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(committed[0].paymentHash, body.checkout.payment_hash);
  assert.match(body.order_access_token, /^or_cap_v1\./);

  wallet.settleInvoice({ payment_hash: body.checkout.payment_hash }, { settled_at: 1010 });
  const checked = await handler(new Request("http://test/openreceive/payments/check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${body.order_access_token}`,
    },
    body: JSON.stringify({ payment_hash: body.checkout.payment_hash }),
  }));
  assert.equal(checked.status, 200);
  assert.equal((await checked.json()).status, "settled");
});

test("HTTP withholds invoice when host persistence fails", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
    tokenKeys: [{ id: "k1", key }],
    configPath: false,
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckoutAmount: () => ({ sats: 1 }),
    onCheckoutCreated: () => { throw new Error("database unavailable"); },
  });
  const response = await handler(new Request("http://test/openreceive/checkouts", {
    method: "POST",
    body: JSON.stringify({ order_id: "order-fail" }),
  }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.checkout, undefined);
  assert.equal(body.code, "CONFLICT");
});

test("HTTP retry reuses the live checkout recorded on the host order", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    tokenKeys: [{ id: "k1", key }],
    clock: () => 1000,
    configPath: false,
  });
  let paymentHash;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckoutAmount: () => ({
      amount: { sats: 10 },
      ...(paymentHash === undefined ? {} : { paymentHash }),
    }),
    onCheckoutCreated: (payment) => { paymentHash = payment.paymentHash; },
  });
  const request = () => new Request("http://test/openreceive/checkouts", {
    method: "POST",
    body: JSON.stringify({ order_id: "retry-order" }),
  });
  const first = await handler(request());
  const second = await handler(request());
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal((await first.json()).checkout.payment_hash, (await second.json()).checkout.payment_hash);
  assert.equal((await wallet.listTransactions({ type: "incoming", unpaid: true, limit: 20 })).transactions.length, 1);
});

test("concurrent host-row loser receives no payer instructions", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
    tokenKeys: [{ id: "k1", key }],
    configPath: false,
  });
  let committed;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckoutAmount: () => ({ sats: 2 }),
    onCheckoutCreated: ({ paymentHash }) => {
      if (committed !== undefined && committed !== paymentHash) throw new Error("compare-and-set lost");
      committed = paymentHash;
    },
  });
  const responses = await Promise.all([1, 2].map(() => handler(new Request(
    "http://test/openreceive/checkouts",
    { method: "POST", body: JSON.stringify({ order_id: "concurrent-order" }) },
  ))));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const loser = await responses.find((response) => response.status === 409).json();
  assert.equal(loser.checkout, undefined);
});

test("HTTP swap retry reuses the host-committed hash and opaque recovery token", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const provider = createTestkitSwapProvider({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    tokenKeys: [{ id: "k1", key }],
    swap: { providers: [provider] },
    clock: () => 1000,
    configPath: false,
  });
  let hostPaymentHash;
  let hostRecoveryToken;
  let commits = 0;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckoutAmount: () => ({
      amount: { sats: 20_000 },
      ...(hostPaymentHash === undefined ? {} : { paymentHash: hostPaymentHash }),
      ...(hostRecoveryToken === undefined ? {} : { swapRecoveryToken: hostRecoveryToken }),
    }),
    onCheckoutCreated: ({ paymentHash, swapRecoveryToken }) => {
      commits += 1;
      hostPaymentHash = paymentHash;
      hostRecoveryToken = swapRecoveryToken;
    },
  });
  const request = () => new Request("http://test/openreceive/swaps", {
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
  assert.equal(firstBody.swap.swap_recovery_token, hostRecoveryToken);
  assert.equal(secondBody.swap.payment_hash, hostPaymentHash);
  assert.equal(commits, 1);
  assert.equal((await wallet.listTransactions({ type: "incoming", unpaid: true, limit: 20 })).transactions.length, 1);
});

test("Node handler satisfies storage-free HTTP golden vectors", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
    tokenKeys: [{ id: "k1", key }],
    configPath: false,
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckoutAmount: () => ({ sats: 1 }),
    onCheckoutCreated: () => {},
  });
  for (const filename of readdirSync("spec/test-vectors/http-golden").sort()) {
    const vector = JSON.parse(readFileSync(`spec/test-vectors/http-golden/${filename}`, "utf8"));
    const response = await handler(new Request(`http://test${vector.request.path}`, {
      method: vector.request.method,
      ...(vector.request.body === undefined ? {} : { body: JSON.stringify(vector.request.body) }),
    }));
    assert.equal(response.status, vector.expected.status, vector.name);
    assert.equal((await response.json()).code, vector.expected.code, vector.name);
  }
});
