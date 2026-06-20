import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TESTKIT_PREIMAGE,
  createTestkitReceiveClient
} from "@openreceive/testkit";

const MAKE_INVOICE_VALIDATION_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/make-invoice-validation.json", "utf8")
);

test("testkit receive client creates deterministic invoices", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 2000 });
  const summary = await wallet.preflight();
  const invoice = await wallet.makeInvoice({
    amount_msats: 200000n,
    description: "Fruit sticker",
    expiry: 90
  });

  assert.equal(summary.receiveCheckoutReady, true);
  assert.deepEqual(summary.methods, ["make_invoice", "lookup_invoice"]);
  assert.equal(invoice.invoice, "lnbcopenreceive000001");
  assert.equal(invoice.payment_hash, "0".repeat(63) + "1");
  assert.equal(invoice.created_at, 2000);
  assert.equal(invoice.expires_at, 2090);
});

test("testkit receive client looks up and settles invoices by payment hash", async () => {
  const notifications = [];
  const wallet = createTestkitReceiveClient({ now: () => 3000 });
  const unsubscribe = await wallet.subscribeToPaymentReceived((notification) => {
    notifications.push(notification);
  });
  const invoice = await wallet.makeInvoice({ amount_msats: 200000n });

  assert.equal(
    (await wallet.lookupInvoice({ payment_hash: invoice.payment_hash })).state,
    "pending"
  );

  const settled = wallet.settleInvoice({
    payment_hash: invoice.payment_hash
  });

  assert.equal(settled.state, "settled");
  assert.equal(settled.transaction_state, "settled");
  assert.equal(settled.settled_at, 3000);
  assert.equal(settled.preimage, TESTKIT_PREIMAGE);
  assert.deepEqual(notifications.map((event) => event.payment_hash), [
    invoice.payment_hash
  ]);

  unsubscribe();
});

test("testkit receive client replays duplicate payment notifications", async () => {
  const notifications = [];
  const wallet = createTestkitReceiveClient({ now: () => 4000 });
  await wallet.subscribeToPaymentReceived((notification) => {
    notifications.push(notification);
  });
  const invoice = await wallet.makeInvoice({ amount_msats: 200000n });

  wallet.settleInvoice({ payment_hash: invoice.payment_hash });
  const replayed = wallet.replayPaymentReceived(
    { payment_hash: invoice.payment_hash },
    2
  );

  assert.equal(replayed.length, 2);
  assert.equal(notifications.length, 3);
  assert.deepEqual(
    notifications.map((notification) => notification.payment_hash),
    [
      invoice.payment_hash,
      invoice.payment_hash,
      invoice.payment_hash
    ]
  );
  assert.equal(notifications.every((notification) => notification.settled_at === 4000), true);
});

test("testkit receive client supports seeded fixtures and terminal states", async () => {
  const wallet = createTestkitReceiveClient({
    initialInvoices: [
      {
        invoice: "lnbcseeded",
        payment_hash: "a".repeat(64),
        amount_msats: 1000n,
        created_at: 100,
        expires_at: 700
      }
    ]
  });

  assert.equal((await wallet.lookupInvoice({ invoice: "lnbcseeded" })).state, "pending");
  assert.equal(wallet.expireInvoice({ invoice: "lnbcseeded" }).state, "expired");
  assert.equal(wallet.failInvoice({ payment_hash: "a".repeat(64) }).state, "failed");
  assert.equal(wallet.listInvoices().length, 1);
});

test("testkit receive client enforces make invoice validation vectors", async () => {
  for (const vector of MAKE_INVOICE_VALIDATION_VECTORS.cases) {
    const wallet = createTestkitReceiveClient();
    const request = makeInvoiceRequestFromVector(vector.request);

    if (vector.expected.valid) {
      const invoice = await wallet.makeInvoice(request);
      assert.equal(invoice.amount_msats, request.amount_msats, vector.name);
    } else {
      await assert.rejects(
        () => wallet.makeInvoice(request),
        Error,
        vector.name
      );
      assert.equal(wallet.listInvoices().length, 0, vector.name);
    }
  }
});

test("testkit receive client enforces amount and metadata boundaries", async () => {
  const wallet = createTestkitReceiveClient();

  await assert.rejects(
    () => wallet.makeInvoice({ amount_msats: 999n }),
    /amount_msats must be at least 1000/
  );
  await assert.rejects(
    () =>
      wallet.makeInvoice({
        amount_msats: 1000n,
        metadata: {
          note: "x".repeat(3901)
        }
      }),
    /metadata must serialize below 3900 bytes/
  );
});

function makeInvoiceRequestFromVector(input) {
  const request = {
    amount_msats: BigInt(input.amount_msats)
  };
  if (input.description !== undefined) request.description = input.description;
  if (input.description_hash !== undefined) {
    request.description_hash = input.description_hash;
  }
  if (input.metadata_note_length !== undefined) {
    request.metadata = {
      note: "x".repeat(input.metadata_note_length)
    };
  }
  return request;
}
