import assert from "node:assert/strict";
import test from "node:test";
import {
  ReceiveCheckoutValidationError,
  createAlbyNwcReceiveClient
} from "../../packages/js/node/src/index.ts";

const NWC_URI =
  "nostr+walletconnect://" +
  "1".repeat(64) +
  "?relay=wss%3A%2F%2Frelay.example.com&secret=" +
  "2".repeat(64);

class FakeAlbyClient {
  makeInvoiceParams = [];
  lookupInvoiceParams = [];
  info = {
    capabilities: ["get_info", "make_invoice", "lookup_invoice", "pay_invoice"],
    notifications: ["payment_received"],
    encryptions: ["nip44_v2", "nip04"]
  };

  async getWalletServiceInfo() {
    return this.info;
  }

  async makeInvoice(params) {
    this.makeInvoiceParams.push(params);
    return {
      invoice: "lnbc-fake",
      payment_hash: "a".repeat(64),
      amount: params.amount,
      state: "pending",
      created_at: 1000,
      expires_at: 1600
    };
  }

  async lookupInvoice(params) {
    this.lookupInvoiceParams.push(params);
    return {
      invoice: "lnbc-fake",
      payment_hash: "a".repeat(64),
      amount: 200000,
      state: "SETTLED",
      settled_at: 1200,
      preimage: "b".repeat(64)
    };
  }
}

test("preflight summarizes receive readiness and warns on spend capability", async () => {
  const fake = new FakeAlbyClient();
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: fake
  });

  const summary = await client.preflight();

  assert.equal(summary.receiveCheckoutReady, true);
  assert.equal(summary.encryption, "nip44_v2");
  assert.equal(summary.spendCapabilityAdvertised, true);
  assert.match(summary.warnings[0], /pay_invoice/);
});

test("receive client maps amount_msats to NIP-47 amount and normalizes results", async () => {
  const fake = new FakeAlbyClient();
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: fake
  });

  const invoice = await client.makeInvoice({
    amount_msats: 200000n,
    description: "Fruit sticker",
    expiry: 600,
    metadata: {
      fruit: "banana"
    }
  });

  assert.deepEqual(fake.makeInvoiceParams[0], {
    amount: 200000,
    description: "Fruit sticker",
    expiry: 600,
    metadata: {
      fruit: "banana"
    }
  });
  assert.equal(invoice.amount_msats, 200000n);

  const lookup = await client.lookupInvoice({
    payment_hash: invoice.payment_hash
  });

  assert.deepEqual(fake.lookupInvoiceParams[0], {
    payment_hash: invoice.payment_hash
  });
  assert.equal(lookup.amount_msats, 200000n);
  assert.equal(lookup.state, "settled");
  assert.equal(lookup.settled_at, 1200);
});

test("receive client rejects metadata above the NWC payload guard", async () => {
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: new FakeAlbyClient()
  });

  await assert.rejects(
    () =>
      client.makeInvoice({
        amount_msats: 200000n,
        description: "Too much metadata",
        metadata: {
          note: "x".repeat(3901)
        }
      }),
    ReceiveCheckoutValidationError
  );
});

test("receive checkout wrapper does not expose payInvoice", () => {
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: new FakeAlbyClient()
  });

  assert.equal("payInvoice" in client, false);
});
