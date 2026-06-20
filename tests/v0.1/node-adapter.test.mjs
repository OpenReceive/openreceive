import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  OpenReceiveError,
  ReceiveCheckoutValidationError,
  createAlbyNwcReceiveClient,
  normalizeNwcWalletError,
  summarizeWalletCapabilities,
  startPaymentNotificationListener
} from "../../packages/js/node/src/index.ts";

const NWC_URI =
  "nostr+walletconnect://" +
  "1".repeat(64) +
  "?relay=wss%3A%2F%2Frelay.example.com&secret=" +
  "2".repeat(64);
const ERROR_NORMALIZATION_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/error-normalization.json", "utf8")
);
const MAKE_INVOICE_VALIDATION_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/make-invoice-validation.json", "utf8")
);
const NWC_INFO_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/nwc-info.json", "utf8")
);
const NWC_REQUEST_RESPONSE_VECTORS = JSON.parse(
  readFileSync("spec/test-vectors/nwc-request-response.json", "utf8")
);

class FakeAlbyClient {
  makeInvoiceParams = [];
  lookupInvoiceParams = [];
  nextResponse = undefined;
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
    if (this.nextResponse !== undefined) return this.nextResponse;
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
    if (this.nextResponse !== undefined) return this.nextResponse;
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

test("summarizes NWC info vectors for readiness and encryption", () => {
  const connection = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: new FakeAlbyClient(),
    requirePreflight: false
  }).connection;

  for (const vector of NWC_INFO_VECTORS.cases) {
    const summary = summarizeWalletCapabilities(connection, vector.raw_info);
    assert.deepEqual(summary.methods, vector.expected.methods, vector.name);
    assert.deepEqual(
      summary.notifications,
      vector.expected.notifications,
      vector.name
    );
    assert.equal(summary.encryption, vector.expected.encryption, vector.name);
    assert.equal(
      summary.spendCapabilityAdvertised,
      vector.expected.spend_capability_advertised,
      vector.name
    );
    assert.equal(
      summary.receiveCheckoutReady,
      vector.expected.receive_checkout_ready,
      vector.name
    );
    for (const method of vector.expected.warning_methods) {
      assert.equal(
        summary.warnings.some((warning) => warning.includes(method)),
        true,
        vector.name
      );
    }
    if (vector.expected.warning_methods.length === 0) {
      assert.equal(summary.warnings.length, 0, vector.name);
    }
  }
});

test("receive client maps amount_msats to NIP-47 amount and normalizes results", async () => {
  for (const vector of NWC_REQUEST_RESPONSE_VECTORS.cases) {
    const fake = new FakeAlbyClient();
    fake.nextResponse = vector.raw_response;
    const client = createAlbyNwcReceiveClient({
      connectionString: NWC_URI,
      client: fake
    });
    const request = makeRequestResponseVectorRequest(vector.openreceive_request);

    if (vector.method === "make_invoice") {
      const invoice = await client.makeInvoice(request);
      assert.deepEqual(
        fake.makeInvoiceParams[0],
        vector.expected_nip47_request,
        vector.name
      );
      assert.deepEqual(
        makeComparableResult(invoice),
        vector.expected_openreceive_response,
        vector.name
      );
    } else if (vector.method === "lookup_invoice") {
      const lookup = await client.lookupInvoice(request);
      assert.deepEqual(
        fake.lookupInvoiceParams[0],
        vector.expected_nip47_request,
        vector.name
      );
      assert.deepEqual(
        makeComparableResult(lookup),
        vector.expected_openreceive_response,
        vector.name
      );
    } else {
      throw new Error(`Unknown vector method: ${vector.method}`);
    }
  }
});

test("receive client enforces make invoice validation vectors", async () => {
  for (const vector of MAKE_INVOICE_VALIDATION_VECTORS.cases) {
    const fake = new FakeAlbyClient();
    const client = createAlbyNwcReceiveClient({
      connectionString: NWC_URI,
      client: fake
    });
    const request = makeInvoiceRequestFromVector(vector.request);

    if (vector.expected.valid) {
      await client.makeInvoice(request);
      assert.equal(fake.makeInvoiceParams.length, 1, vector.name);
    } else {
      await assert.rejects(
        () => client.makeInvoice(request),
        ReceiveCheckoutValidationError,
        vector.name
      );
      assert.equal(fake.makeInvoiceParams.length, 0, vector.name);
    }
  }
});

test("normalizes NWC wallet errors into canonical OpenReceive codes", async () => {
  for (const vector of ERROR_NORMALIZATION_VECTORS.cases) {
    const normalized = normalizeNwcWalletError(vector.raw_error);
    assert.equal(normalized instanceof OpenReceiveError, true, vector.name);
    assert.deepEqual(normalized.toJSON(), vector.expected, vector.name);
  }
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

test("payment notification listener re-verifies a redelivered notification after a transient lookup error", async () => {
  const settled = [];
  const errors = [];
  let lookupCalls = 0;
  const client = {
    handler: undefined,
    async subscribeToPaymentReceived(handler) {
      this.handler = handler;
      return () => {};
    },
    async lookupInvoice({ payment_hash }) {
      lookupCalls += 1;
      if (lookupCalls === 1) {
        throw new Error("transient relay timeout");
      }
      return { payment_hash, state: "settled", settled_at: 1300 };
    }
  };

  const listener = await startPaymentNotificationListener({
    client,
    onSettledInvoice: (event) => settled.push(event),
    onError: (error) => errors.push(error)
  });

  const notification = { payment_hash: "a".repeat(64), amount_msats: 200000n };
  // At-least-once: the first delivery fails verification (transient error) and
  // must NOT mark the hash seen, so the redelivery re-triggers lookup + credit.
  await client.handler(notification);
  await client.handler(notification);

  assert.equal(lookupCalls, 2);
  assert.equal(errors.length, 1);
  assert.equal(settled.length, 1);
  assert.equal(listener.seenPaymentHashes.has("a".repeat(64)), true);

  // A third delivery after a credited settlement is now deduped.
  await client.handler(notification);
  assert.equal(lookupCalls, 2);
  assert.equal(settled.length, 1);
});

test("receive client normalizes legacy boolean settled/paid lookup variants", async () => {
  const fake = new FakeAlbyClient();
  const client = createAlbyNwcReceiveClient({
    connectionString: NWC_URI,
    client: fake
  });

  fake.nextResponse = {
    invoice: "lnbc-bool",
    payment_hash: "a".repeat(64),
    amount_msats: 200000,
    settled: true
  };
  const settledLookup = await client.lookupInvoice({ payment_hash: "a".repeat(64) });
  assert.equal(settledLookup.transaction_state, "settled");
  assert.equal(settledLookup.state, undefined);

  fake.nextResponse = {
    invoice: "lnbc-paid",
    payment_hash: "b".repeat(64),
    amount_msats: 200000,
    paid: true
  };
  const paidLookup = await client.lookupInvoice({ payment_hash: "b".repeat(64) });
  assert.equal(paidLookup.transaction_state, "settled");
  assert.equal(paidLookup.state, undefined);
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

function makeRequestResponseVectorRequest(input) {
  const request = { ...input };
  if (input.amount_msats !== undefined) {
    request.amount_msats = BigInt(input.amount_msats);
  }
  return request;
}

function makeComparableResult(result) {
  const comparable = { ...result };
  if (typeof comparable.amount_msats === "bigint") {
    comparable.amount_msats = Number(comparable.amount_msats);
  }
  return comparable;
}
