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
  assert.deepEqual(summary.methods, ["make_invoice", "list_transactions"]);
  assert.equal(invoice.invoice, "lnbcopenreceive000001");
  assert.equal(invoice.payment_hash, "0".repeat(63) + "1");
  assert.equal(invoice.created_at, 2000);
  assert.equal(invoice.expires_at, 2090);
});

test("testkit receive client lists and settles invoices by payment hash", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 3000 });
  const invoice = await wallet.makeInvoice({ amount_msats: 200000n });

  assert.equal(
    firstTransaction(await wallet.listTransactions({
      type: "incoming",
      unpaid: true,
      from: invoice.created_at,
      until: invoice.created_at,
      limit: 20,
      offset: 0
    })).state,
    "pending"
  );

  const settled = wallet.settleInvoice({
    payment_hash: invoice.payment_hash
  });

  assert.equal(settled.state, "settled");
  assert.equal(settled.transaction_state, "settled");
  assert.equal(settled.settled_at, 3000);
  assert.equal(settled.preimage, TESTKIT_PREIMAGE);
});

test("testkit receive client scripts deterministic transaction sequences", async () => {
  const wallet = createTestkitReceiveClient({ now: () => 5000 });
  const invoice = await wallet.makeInvoice({ amount_msats: 200000n });

  wallet.scriptTransactionSequence(
    { payment_hash: invoice.payment_hash },
    [
      { state: "pending" },
      { error: "wallet transaction timeout" },
      {
        state: "settled",
        settled_at: 5010,
        preimage: "2".repeat(64)
      }
    ]
  );

  assert.equal(
    firstTransaction(await wallet.listTransactions({
      type: "incoming",
      unpaid: true,
      from: invoice.created_at,
      until: invoice.created_at,
      limit: 20,
      offset: 0
    })).state,
    "pending"
  );
  await assert.rejects(
    () => wallet.listTransactions({
      type: "incoming",
      unpaid: true,
      from: invoice.created_at,
      until: invoice.created_at,
      limit: 20,
      offset: 0
    }),
    /wallet transaction timeout/
  );

  const settled = firstTransaction(await wallet.listTransactions({
    type: "incoming",
    unpaid: true,
    from: invoice.created_at,
    until: invoice.created_at,
    limit: 20,
    offset: 0
  }));
  assert.equal(settled.state, "settled");
  assert.equal(settled.transaction_state, "settled");
  assert.equal(settled.settled_at, 5010);
  assert.equal(settled.preimage, "2".repeat(64));

  assert.equal(
    firstTransaction(await wallet.listTransactions({
      type: "incoming",
      unpaid: true,
      from: invoice.created_at,
      until: invoice.created_at,
      limit: 20,
      offset: 0
    })).state,
    "settled"
  );

  wallet.clearTransactionSequence({ payment_hash: invoice.payment_hash });
  assert.equal(wallet.failInvoice({ payment_hash: invoice.payment_hash }).state, "failed");
  assert.equal(
    firstTransaction(await wallet.listTransactions({
      type: "incoming",
      unpaid: true,
      from: invoice.created_at,
      until: invoice.created_at,
      limit: 20,
      offset: 0
    })).state,
    "failed"
  );
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

  assert.equal(firstTransaction(await wallet.listTransactions({
    type: "incoming",
    unpaid: true,
    from: 100,
    until: 100,
    limit: 20,
    offset: 0
  })).state, "pending");
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

function firstTransaction(result) {
  assert.equal(result.transactions.length > 0, true);
  return result.transactions[0];
}
