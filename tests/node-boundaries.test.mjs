import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import * as openReceiveNode from "../packages/js/node/src/index.ts";
import { createOpenReceive } from "../packages/js/node/src/index.ts";
import {
  createTestkitReceiveClient,
  createTestkitSwapProvider,
} from "../packages/js/testkit/src/index.ts";

// The payments repository moved to @openreceive/http; the Node service stays
// persistence-free: no repository, schema, or SQL adapter surface leaks here.
test("@openreceive/node exports no persistence surface", () => {
  const names = Object.keys(openReceiveNode);
  assert.ok(names.includes("createOpenReceive"));
  for (const banned of [
    "createOpenReceiveSqlPayments",
    "createOpenReceiveHost",
    "openReceivePaymentsSchemaSql",
    "resolveSqlAdapter",
    "listUnsettledAttempts",
  ]) {
    assert.ok(!names.includes(banned), `@openreceive/node must not export ${banned}`);
  }
  for (const name of names) {
    assert.doesNotMatch(
      name,
      /sql|repositor|schema|migration/i,
      `unexpected persistence export ${name}`,
    );
  }
});

test("@openreceive/node runtime never imports a database driver", () => {
  const sourceDir = "packages/js/node/src";
  const sources = readdirSync(sourceDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"))
    // Scaffold guides emit host-owned wiring snippets (template strings), where
    // driver imports are the host's own code, not this library's module graph.
    .filter((name) => !name.startsWith("scaffold/") && !name.startsWith("scaffold\\"));
  assert.ok(sources.length > 0);
  for (const filename of sources) {
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
      /DATABASE_URL|REDIS_URL|POSTGRES_URL/,
      `${filename} must not read a storage connection URL`,
    );
  }
});

test("createCheckout fails closed when the wallet ignores the requested expiry", async () => {
  const now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const requested = [];
  const originalMakeInvoice = wallet.makeInvoice.bind(wallet);
  wallet.makeInvoice = async (request) => {
    requested.push(request);
    const invoice = await originalMakeInvoice(request);
    // Simulate wallets that ignore expiry and mint a 60-minute invoice.
    return { ...invoice, expires_at: now + 3600 };
  };
  const events = [];
  const openreceive = await createOpenReceive({
    client: wallet,
    clock: () => now,
    onEvent: (event) => events.push(event),
  });

  await assert.rejects(
    () => openreceive.createCheckout({ orderId: "order-expiry", amount: { sats: 1000 } }),
    (error) => {
      assert.equal(error.code, "UNSUPPORTED_METHOD");
      // The buyer-facing message stays short; the requested/actual numbers
      // belong to the checkout.invoice_expiry.rejected log event instead.
      assert.match(error.message, /backing NWC wallet.*did not honor the requested invoice expiry/);
      assert.doesNotMatch(error.message, /600|3600/);
      return true;
    },
  );
  assert.equal(requested[0]?.expiry, 600);
  const rejection = events.find((event) => event.event === "checkout.invoice_expiry.rejected");
  assert.equal(rejection?.level, "error");
  assert.equal(rejection?.requested_expiry_seconds, 600);
  assert.equal(rejection?.actual_expiry_seconds, 3600);
  await openreceive.close();
});

test("createCheckout records the amount the wallet actually minted", async () => {
  const now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const originalMakeInvoice = wallet.makeInvoice.bind(wallet);
  wallet.makeInvoice = async (request) => {
    const invoice = await originalMakeInvoice(request);
    // Simulate a wallet quoting its own amount: 1 sat short.
    return { ...invoice, amount_msats: invoice.amount_msats - 1000n };
  };
  const openreceive = await createOpenReceive({ client: wallet, clock: () => now });

  // The wallet is trusted, so the checkout carries the wallet's amount rather
  // than the requested one — the ledger row always matches the payer's invoice.
  const checkout = await openreceive.createCheckout({
    orderId: "order-amount",
    amount: { sats: 1000 },
  });
  assert.equal(checkout.amountMsats, 999_000);
  await openreceive.close();
});

test("createCheckout accepts a wallet expiry within the small tolerance", async () => {
  const now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const originalMakeInvoice = wallet.makeInvoice.bind(wallet);
  wallet.makeInvoice = async (request) => {
    const invoice = await originalMakeInvoice(request);
    // A wallet that rounds or processes slowly may deviate slightly.
    return { ...invoice, expires_at: now + 600 + 30 };
  };
  const openreceive = await createOpenReceive({
    client: wallet,
    clock: () => now,
  });

  const checkout = await openreceive.createCheckout({
    orderId: "order-expiry-tolerance",
    amount: { sats: 1000 },
  });
  assert.equal(checkout.expiresAt, now + 630);
  await openreceive.close();
});

test("Node service creates without persistence and verifies by payment_hash", async () => {
  let now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const openreceive = await createOpenReceive({
    client: wallet,
    clock: () => now,
  });

  const first = await openreceive.createCheckout({
    orderId: "order-1",
    amount: { currency: "USD", value: "10.00" },
  });
  const second = await openreceive.createCheckout({
    orderId: "order-1",
    amount: { currency: "USD", value: "10.00" },
  });
  assert.notEqual(first.paymentHash, second.paymentHash, "host payment repository is the guard");
  assert.equal(
    (
      await openreceive.checkPayment({
        paymentHash: first.paymentHash,
        createdAt: first.createdAt,
      })
    ).status,
    "pending",
  );

  now = 1100;
  wallet.settleInvoice({ payment_hash: first.paymentHash }, { settled_at: now });
  const paid = await openreceive.checkPayment({
    paymentHash: first.paymentHash,
    createdAt: first.createdAt,
  });
  assert.equal(paid.status, "settled");
  assert.equal(paid.paidAt, 1100);

  await openreceive.close();
});

test("reconcilePayments batches known attempts into shared list_transactions scans", async () => {
  let now = 1000;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const requests = [];
  const originalList = wallet.listTransactions.bind(wallet);
  wallet.listTransactions = async (request) => {
    requests.push(request);
    return originalList(request);
  };
  const openreceive = await createOpenReceive({
    client: wallet,
    clock: () => now,
  });
  const attempts = await Promise.all(
    ["one", "two", "three"].map((orderId) =>
      openreceive.createCheckout({ orderId, amount: { sats: 1000 } }),
    ),
  );
  now = 1100;
  wallet.settleInvoice({ payment_hash: attempts[1].paymentHash }, { settled_at: now });

  const checked = await openreceive.reconcilePayments({
    attempts: attempts.map((attempt) => ({
      paymentHash: attempt.paymentHash,
      createdAt: attempt.createdAt,
    })),
  });

  assert.equal(checked.filter((payment) => payment.status === "settled").length, 1);
  assert.ok(requests.length <= 2, "reconciliation scans history once per wallet view");
  await openreceive.close();
});

test("host-serialized swap data recovers provider state and provider state controls refunds", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 1000 });
  const provider = createTestkitSwapProvider({ now: () => 1000 });
  const openreceive = await createOpenReceive({
    client: wallet,
    swap: { providers: [provider] },
    clock: () => 1000,
  });
  const swap = await openreceive.createSwap({
    orderId: "swap-1",
    amount: { sats: 20_000 },
    payInAsset: "USDT_TRON",
  });
  assert.equal(swap.swapData.version, 1);
  assert.equal(swap.swapData.paymentHash, undefined);
  assert.equal(swap.swapData.orderId, undefined);
  const storedSwapData = JSON.parse(JSON.stringify(swap.swapData));

  provider.forceRefundRequired({ providerOrderId: "testkit-swap-1" });
  const status = await openreceive.getSwap({
    orderId: swap.orderId,
    paymentHash: swap.paymentHash,
    swapData: storedSwapData,
  });
  assert.equal(status.providerState, "refund_required");
  const refunded = await openreceive.refundSwap({
    orderId: swap.orderId,
    paymentHash: swap.paymentHash,
    swapData: storedSwapData,
    refundAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  });
  assert.equal(refunded.providerState, "refund_pending");
});
