import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { createOpenReceive } from "../../packages/js/node/src/index.ts";
import { createOpenReceiveHttpHandler } from "../../packages/js/http/src/index.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../../packages/js/testkit/src/index.ts";

test("HTTP commits payment hash before returning payer instructions", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    clock: () => 1000,
  });
  const committed = [];
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckout: () => ({
      amount: { sats: 1234 },
      ...(committed[0] === undefined ? {} : { paymentHash: committed[0].paymentHash }),
    }),
    onCheckoutCreated: (payment) => committed.push(payment),
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
  assert.equal((await checked.json()).status, "settled");
});

test("HTTP withholds invoice when host persistence fails", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckout: () => ({ sats: 1 }),
    onCheckoutCreated: () => {
      throw new Error("database unavailable");
    },
  });
  const response = await handler(
    new Request("http://test/openreceive/checkouts", {
      method: "POST",
      body: JSON.stringify({ order_id: "order-fail" }),
    }),
  );
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.checkout, undefined);
  assert.equal(body.code, "CONFLICT");
});

test("HTTP retry reuses the live checkout recorded on the host order", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    clock: () => 1000,
  });
  let paymentHash;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckout: () => ({
      amount: { sats: 10 },
      ...(paymentHash === undefined ? {} : { paymentHash }),
    }),
    onCheckoutCreated: (payment) => {
      paymentHash = payment.paymentHash;
    },
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

test("concurrent host-row loser receives no payer instructions", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
  });
  let committed;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckout: () => ({ sats: 2 }),
    onCheckoutCreated: ({ paymentHash }) => {
      if (committed !== undefined && committed !== paymentHash)
        throw new Error("compare-and-set lost");
      committed = paymentHash;
    },
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
});

test("HTTP swap retry reuses host-committed hash/data without exposing provider state", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const provider = createTestkitSwapProvider({ now: () => 1000 });
  const service = await createOpenReceive({
    client: wallet,
    swap: { providers: [provider] },
    clock: () => 1000,
  });
  let hostPaymentHash;
  let hostSwapData;
  let commits = 0;
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckout: () => ({
      amount: { sats: 20_000 },
      ...(hostPaymentHash === undefined ? {} : { paymentHash: hostPaymentHash }),
      ...(hostSwapData === undefined ? {} : { swapData: hostSwapData }),
    }),
    onCheckoutCreated: ({ paymentHash, swapData }) => {
      commits += 1;
      hostPaymentHash = paymentHash;
      hostSwapData = JSON.parse(JSON.stringify(swapData));
    },
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

test("Node handler satisfies storage-free HTTP golden vectors", async () => {
  const service = await createOpenReceive({
    client: createTestkitReceiveClient(),
  });
  const handler = createOpenReceiveHttpHandler({
    service,
    authorize: () => true,
    resolveCheckout: () => ({ sats: 1 }),
    onCheckoutCreated: () => {},
  });
  for (const filename of readdirSync("spec/test-vectors/http-golden").sort()) {
    const vector = JSON.parse(readFileSync(`spec/test-vectors/http-golden/${filename}`, "utf8"));
    const response = await handler(
      new Request(`http://test${vector.request.path}`, {
        method: vector.request.method,
        ...(vector.request.body === undefined ? {} : { body: JSON.stringify(vector.request.body) }),
      }),
    );
    assert.equal(response.status, vector.expected.status, vector.name);
    assert.equal((await response.json()).code, vector.expected.code, vector.name);
  }
});
