import assert from "node:assert/strict";
import test from "node:test";
import {
  OpenReceiveError,
  ReceiveCheckoutValidationError,
  createAlbyNwcReceiveClient,
  normalizeNwcWalletError,
  startPaymentNotificationListener
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

test("normalizes NWC wallet errors into canonical OpenReceive codes", async () => {
  const insufficient = normalizeNwcWalletError({
    error: {
      code: "insufficient-balance",
      message: "Wallet lacks spendable sats",
      request_id: "req_balance"
    }
  });
  assert.equal(insufficient instanceof OpenReceiveError, true);
  assert.deepEqual(insufficient.toJSON(), {
    code: "INSUFFICIENT_BALANCE",
    message: "Wallet lacks spendable sats",
    retryable: false,
    request_id: "req_balance"
  });

  const timeout = normalizeNwcWalletError(
    Object.assign(new Error("Relay request timed out"), {
      name: "TimeoutError"
    })
  );
  assert.equal(timeout.code, "TIMEOUT");
  assert.equal(timeout.retryable, true);

  const nativeSendError = normalizeNwcWalletError({
    code: "PAYMENT_FAILED",
    message: "Payment route failed"
  });
  assert.equal(nativeSendError.code, "PAYMENT_FAILED");
  assert.equal(nativeSendError.retryable, false);

  const networkError = normalizeNwcWalletError(
    Object.assign(new Error("Failed to connect to relay"), {
      name: "Nip47NetworkError",
      code: "OTHER"
    })
  );
  assert.equal(networkError.code, "WALLET_UNAVAILABLE");
  assert.equal(networkError.retryable, true);
});

test("receive client throws normalized wallet errors from make_invoice", async () => {
  class ErroringMakeInvoiceClient extends FakeAlbyClient {
    async makeInvoice(params) {
      this.makeInvoiceParams.push(params);
      throw {
        error: {
          code: "payment_failed",
          message: "Wallet could not create this invoice"
        }
      };
    }
  }

  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: new ErroringMakeInvoiceClient()
  });

  await assert.rejects(
    () =>
      client.makeInvoice({
        amount_msats: 200000n,
        description: "Fruit sticker"
      }),
    (error) => {
      assert.equal(error instanceof OpenReceiveError, true);
      assert.equal(error.code, "PAYMENT_FAILED");
      assert.equal(error.message, "Wallet could not create this invoice");
      assert.equal(error.retryable, false);
      return true;
    }
  );
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

test("payment notification listener dedupes and verifies settlement with lookup", async () => {
  const client = new FakeNotificationClient();
  const settled = [];
  const listener = await startPaymentNotificationListener({
    client,
    onSettledInvoice: (event) => settled.push(event)
  });

  await client.emit({
    payment_hash: "d".repeat(64),
    amount_msats: 200000n,
    settled_at: 1300
  });
  await client.emit({
    payment_hash: "d".repeat(64),
    amount_msats: 200000n,
    settled_at: 1300
  });

  assert.equal(client.lookupCalls, 1);
  assert.equal(settled.length, 1);
  assert.equal(settled[0].lookup.state, "settled");
  assert.equal(listener.seenPaymentHashes.has("d".repeat(64)), true);

  await listener.stop();
  assert.equal(client.unsubscribed, true);
});

test("payment notification listener does not fulfill unsettled lookup results", async () => {
  const client = new FakeNotificationClient();
  client.lookupState = "pending";
  const settled = [];
  const unsettled = [];
  await startPaymentNotificationListener({
    client,
    onSettledInvoice: (event) => settled.push(event),
    onUnsettledNotification: (event) => unsettled.push(event)
  });

  await client.emit({
    payment_hash: "c".repeat(64)
  });

  assert.equal(settled.length, 0);
  assert.equal(unsettled.length, 1);
  assert.equal(unsettled[0].lookup.state, "pending");
});

class FakeNotificationClient {
  handler = undefined;
  lookupCalls = 0;
  lookupState = "settled";
  unsubscribed = false;

  async preflight() {
    return {
      walletPubkey: "f".repeat(64),
      relays: ["wss://relay.example.com"],
      methods: ["make_invoice", "lookup_invoice"],
      notifications: ["payment_received"],
      encryption: "nip04",
      spendCapabilityAdvertised: false,
      receiveCheckoutReady: true,
      warnings: []
    };
  }

  async makeInvoice() {
    throw new Error("not needed");
  }

  async lookupInvoice(request) {
    this.lookupCalls += 1;
    return {
      invoice: "lnbc-fake",
      payment_hash: request.payment_hash,
      amount_msats: 200000n,
      state: this.lookupState,
      settled_at: this.lookupState === "settled" ? 1300 : undefined
    };
  }

  async subscribeToPaymentReceived(handler) {
    this.handler = handler;
    return () => {
      this.unsubscribed = true;
    };
  }

  async emit(notification) {
    await this.handler(notification);
  }
}
