import assert from "node:assert/strict";
import test from "node:test";
import { memoryPaymentsDb } from "./helpers/factories.mjs";
import { reconcilePaymentAttempts } from "../packages/js/core/src/index.ts";
import { createHost, reconcileHostPayments } from "../packages/js/http/src/index.ts";

const PAGE = 20;
// Ordered hashes: index 0 < index 1 < ... as hex strings, so scan-window
// assertions can name a position in the wallet's history. This is NOT the
// shared `hash()` in ./helpers/factories.mjs, which is the unordered repeat
// form; the two are not interchangeable.
const orderedHash = (value) => value.toString(16).padStart(64, "0");

/** A wallet whose history is `count` incoming rows, newest last, plus extras. */
function walletWith(transactions) {
  const requests = [];
  return {
    requests,
    client: {
      async listTransactions(request) {
        requests.push(request);
        const offset = request.offset ?? 0;
        const limit = request.limit ?? transactions.length;
        return { transactions: transactions.slice(offset, offset + limit) };
      },
    },
  };
}

function settledRow(paymentHash, createdAt) {
  return {
    type: "incoming",
    payment_hash: paymentHash,
    created_at: createdAt,
    state: "settled",
    settled_at: createdAt + 1,
  };
}

function pendingRow(paymentHash, createdAt) {
  return { type: "incoming", payment_hash: paymentHash, created_at: createdAt, state: "pending" };
}

test("a page-capped walk decides nothing instead of reporting not_found", async () => {
  const target = orderedHash(0xbeef);
  // A full first page of unrelated rows, with the match only on page two.
  const history = [
    ...Array.from({ length: PAGE }, (_, index) => pendingRow(orderedHash(index + 1), 100 + index)),
    settledRow(target, 150),
  ];
  const wallet = walletWith(history);

  const capped = await reconcilePaymentAttempts({
    client: wallet.client,
    attempts: [{ paymentHash: target, createdAt: 150 }],
    clock: () => 1_000,
    maxPages: 1,
  });
  assert.deepEqual(capped, [], "a truncated walk must not claim the invoice is absent");

  // The same scan without the cap reaches page two and settles it.
  const complete = await reconcilePaymentAttempts({
    client: walletWith(history).client,
    attempts: [{ paymentHash: target, createdAt: 150 }],
    clock: () => 1_000,
  });
  assert.equal(complete.length, 1);
  assert.equal(complete[0].status, "settled");
});

test("a truncated pass leaves an expired attempt pending instead of closing it", async () => {
  // The attempt expired long before the scan (1_000 > 50 + the 900s grace), so
  // a genuine not_found here would close it as expired. The wallet holds the
  // settlement on page two, out of reach of a one-page walk.
  const now = 1_000;
  const paymentHash = orderedHash(0xbeef);
  const history = [
    ...Array.from({ length: PAGE }, (_, index) => pendingRow(orderedHash(index + 1), 10 + index)),
    settledRow(paymentHash, 45),
  ];
  const wallet = walletWith(history);
  const db = memoryPaymentsDb();
  const settled = [];
  const host = createHost({
    db,
    clock: () => now,
    loadOrder: async (orderId) => ({ orderId }),
    amountForOrder: () => ({ sats: 1 }),
    onPaid: async (settlement) => settled.push(settlement.paymentHash),
  });
  await host.onCheckoutCreated({
    orderId: "order-truncated",
    paymentHash,
    checkout: {
      orderId: "order-truncated",
      paymentHash,
      bolt11: "lnbc-truncated",
      amountMsats: 1_000,
      createdAt: 40,
      expiresAt: 50,
      fiatQuote: null,
    },
  });

  const service = {
    reconcilePayments: (input) =>
      reconcilePaymentAttempts({
        client: wallet.client,
        attempts: input.attempts,
        clock: () => now,
        maxPages: 1,
      }),
  };
  await reconcileHostPayments({ service, host, clock: () => now });

  const row = (await host.payments.listForOrder("order-truncated"))[0];
  assert.equal(row.status, "pending", "a capped scan must never close a possibly-paid attempt");
  assert.equal(row.statusReason, null);
  assert.deepEqual(settled, []);

  // The next pass, with pages to spare, finds the settlement and delivers it.
  const complete = {
    reconcilePayments: (input) =>
      reconcilePaymentAttempts({
        client: walletWith(history).client,
        attempts: input.attempts,
        clock: () => now,
      }),
  };
  await reconcileHostPayments({ service: complete, host, clock: () => now });
  assert.deepEqual(settled, [paymentHash]);
  assert.equal((await host.payments.listForOrder("order-truncated"))[0].status, "settled");
});

test("the walk stops once every expected hash is accounted for", async () => {
  const target = orderedHash(1);
  const history = [
    settledRow(target, 100),
    ...Array.from({ length: PAGE * 3 }, (_, index) =>
      pendingRow(orderedHash(index + 2), 101 + index),
    ),
  ];
  const wallet = walletWith(history);

  const checks = await reconcilePaymentAttempts({
    client: wallet.client,
    attempts: [{ paymentHash: target, createdAt: 100 }],
    clock: () => 1_000,
  });
  assert.equal(checks[0].status, "settled");
  assert.equal(wallet.requests.length, 1, "a satisfied walk must not keep paging");
});

test("a wallet that ignores offset is stopped instead of paged to the cap", async () => {
  const page = Array.from({ length: PAGE }, (_, index) =>
    pendingRow(orderedHash(index + 1), 100 + index),
  );
  const requests = [];
  const client = {
    async listTransactions(request) {
      requests.push(request);
      // Broken wallet: the same full page for every offset.
      return { transactions: page };
    },
  };

  const checks = await reconcilePaymentAttempts({
    client,
    attempts: [{ paymentHash: orderedHash(0xbeef), createdAt: 100 }],
    clock: () => 1_000,
    maxPages: 500,
  });
  // Two walks (default, then the inclusive unpaid view), each stopping as soon
  // as the wallet repeats itself rather than walking 500 identical pages.
  assert.ok(requests.length <= 6, `repeated pages must end the walk: ${requests.length}`);
  assert.deepEqual(checks, [], "a walk that never advanced proves nothing");
});

test("the scan window pads both ends against wallet clock skew", async () => {
  // The wallet stamped the invoice 30 seconds ahead of the host clock. With an
  // unpadded `until` the row would sit outside the window until the host caught up.
  const paymentHash = orderedHash(7);
  const now = 1_000;
  const requests = [];
  const client = {
    async listTransactions(request) {
      requests.push(request);
      const created = 1_030;
      const visible = created >= (request.from ?? 0) && created <= (request.until ?? Infinity);
      return { transactions: visible ? [settledRow(paymentHash, created)] : [] };
    },
  };

  const checks = await reconcilePaymentAttempts({
    client,
    attempts: [{ paymentHash, createdAt: 1_030 }],
    clock: () => now,
  });
  assert.equal(checks[0].status, "settled");
  assert.equal(requests[0].from, 1_030 - 60);
  assert.equal(requests[0].until, now + 60);

  // An explicit `until` still wins.
  requests.length = 0;
  await reconcilePaymentAttempts({
    client,
    attempts: [{ paymentHash, createdAt: 1_030 }],
    clock: () => now,
    until: 2_000,
  });
  assert.equal(requests[0].until, 2_000);
});
