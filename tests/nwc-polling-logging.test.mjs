import assert from "node:assert/strict";
import test from "node:test";
import { createNwcReceiveClient, createOpenReceive } from "../packages/js/node/src/index.ts";
import { createNwcEndpointLogger } from "../packages/js/node/src/service/logging.ts";
import { createTestkitReceiveClient } from "../packages/js/testkit/src/index.ts";

const PAYMENT_HASH = "a".repeat(64);
// Constructed so no real-looking NWC URI literal exists in the repository.
const NWC_URI = `nostr+walletconnect://${"a".repeat(64)}?relay=wss://relay.example&secret=${"b".repeat(64)}`;

test("createOpenReceive logs payment.check NWC poll request and result", async () => {
  const events = [];
  const now = 1_700_000_100;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const created = await wallet.makeInvoice({ amount_msats: 4_000_000n });
  wallet.settleInvoice({ payment_hash: created.payment_hash }, { settled_at: now });

  const service = await createOpenReceive({
    client: wallet,
    clock: () => now,
    env: {},
    logger: (entry) => events.push(entry),
  });

  try {
    const checked = await service.checkPayment({
      paymentHash: created.payment_hash,
      createdAt: created.created_at,
    });
    assert.equal(checked.status, "settled");

    const requested = events.find((entry) => entry.event === "payment.check.requested");
    const completed = events.find((entry) => entry.event === "payment.check.completed");
    assert.ok(requested, "expected payment.check.requested");
    assert.equal(requested.level, "debug");
    assert.equal(requested.payment_hash, created.payment_hash);
    assert.equal(requested.created_at, created.created_at);
    assert.ok(completed, "expected payment.check.completed");
    assert.equal(completed.level, "info");
    assert.equal(completed.status, "settled");
    assert.equal(completed.payment_hash, created.payment_hash);
    assert.equal(completed.preimage_present, true);
  } finally {
    await service.close();
  }
});

test("createOpenReceive logs payment.check when the wallet has not settled yet", async () => {
  const events = [];
  const now = 1_700_000_100;
  const wallet = createTestkitReceiveClient({ now: () => now });
  const created = await wallet.makeInvoice({ amount_msats: 4_000_000n });

  const service = await createOpenReceive({
    client: wallet,
    clock: () => now,
    env: {},
    logger: (entry) => events.push(entry),
  });

  try {
    const checked = await service.checkPayment({
      paymentHash: created.payment_hash,
      createdAt: created.created_at,
    });
    assert.equal(checked.status, "pending");

    const completed = events.find((entry) => entry.event === "payment.check.completed");
    assert.ok(completed, "expected payment.check.completed");
    assert.equal(completed.level, "debug");
    assert.equal(completed.status, "pending");
    assert.equal(completed.preimage_present, false);
  } finally {
    await service.close();
  }
});

test("createNwcEndpointLogger forwards list_transactions polls into the service logger", async () => {
  const events = [];
  const logger = createNwcEndpointLogger({
    logger: (entry) => events.push(entry),
  });
  assert.ok(logger !== undefined);

  const client = createNwcReceiveClient({
    connectionString: NWC_URI,
    requirePreflight: false,
    logger,
    client: {
      listTransactions: async () => ({
        transactions: [
          {
            type: "incoming",
            state: "settled",
            payment_hash: PAYMENT_HASH,
            amount: 4_000_000,
            created_at: 1_700_000_000,
            settled_at: 1_700_000_050,
            preimage: "c".repeat(64),
          },
        ],
      }),
    },
  });

  const result = await client.listTransactions({
    type: "incoming",
    from: 1_700_000_000,
    until: 1_700_000_100,
    limit: 20,
    offset: 0,
  });
  assert.equal(result.transactions.length, 1);

  assert.ok(
    events.some(
      (entry) =>
        entry.event === "nwc.list_transactions.requested" &&
        entry.method === "list_transactions" &&
        entry.from === 1_700_000_000,
    ),
    "expected nwc.list_transactions.requested",
  );
  assert.ok(
    events.some(
      (entry) => entry.event === "nwc.list_transactions.completed" && entry.transaction_count === 1,
    ),
    "expected nwc.list_transactions.completed",
  );
  assert.doesNotMatch(JSON.stringify(events), /bbbbbbbbbbbbbbbb/);
});

test("make_invoice logs msat amounts as strings so huge values stay exact", async () => {
  const events = [];
  // Wallet-reported amounts are not bounded by the request validator, and above
  // 2^53 Number() would round this to 9007199254740992.
  const walletAmountMsats = 9_007_199_254_740_993n;
  const client = createNwcReceiveClient({
    connectionString: NWC_URI,
    requirePreflight: false,
    logger: (entry) => events.push(entry),
    client: {
      makeInvoice: async () => ({
        invoice: "lnbc1",
        payment_hash: PAYMENT_HASH,
        amount_msats: walletAmountMsats,
      }),
    },
  });

  const result = await client.makeInvoice({ amount_msats: 4_000_000n });
  assert.equal(result.amount_msats, walletAmountMsats);

  const requested = events.find((entry) => entry.event === "nwc.make_invoice.requested");
  const completed = events.find((entry) => entry.event === "nwc.make_invoice.completed");
  assert.equal(requested.amount_msats, "4000000");
  assert.equal(completed.amount_msats, "9007199254740993");
});
