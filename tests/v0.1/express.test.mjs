import assert from "node:assert/strict";
import test from "node:test";
import {
  createOpenReceiveExpressHandlers,
  InMemoryInvoiceEventBus
} from "../../packages/js/express/src/index.ts";
import {
  InMemoryInvoiceStore
} from "../../packages/js/core/src/index.ts";

const PAYMENT_HASH = "e".repeat(64);

class FakeWallet {
  makeInvoiceCalls = 0;
  lookupState = "pending";

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

  async makeInvoice(request) {
    this.makeInvoiceCalls += 1;
    return {
      invoice: "lnbc-demo",
      payment_hash: PAYMENT_HASH,
      amount_msats: BigInt(request.amount_msats ?? request.amount),
      created_at: 1000,
      expires_at: 1600
    };
  }

  async lookupInvoice() {
    return {
      invoice: "lnbc-demo",
      payment_hash: PAYMENT_HASH,
      amount_msats: 200000n,
      state: this.lookupState,
      settled_at: this.lookupState === "settled" ? 1200 : undefined,
      preimage: this.lookupState === "settled" ? "1".repeat(64) : undefined
    };
  }
}

function createHarness() {
  const wallet = new FakeWallet();
  const store = new InMemoryInvoiceStore();
  const eventBus = new InMemoryInvoiceEventBus();
  const handlers = createOpenReceiveExpressHandlers({
    client: wallet,
    store,
    eventBus,
    merchantScope: () => "demo:hello-fruit",
    unsafeAllowUnauthenticatedDemoMode: true,
    clock: () => 1000,
    heartbeatSeconds: 1
  });

  return { wallet, store, eventBus, handlers };
}

test("create invoice uses idempotency replay without a second wallet call", async () => {
  const { wallet, handlers } = createHarness();
  const req = createRequest({
    headers: {
      "idempotency-key": "order-1"
    },
    body: {
      amount_msats: 200000,
      description: "Fruit sticker",
      expiry: 600,
      metadata: {
        fruit: "banana"
      }
    }
  });

  const first = createResponse();
  await handlers.createInvoice(req, first, raiseNext);
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.transaction_state, "pending");

  const second = createResponse();
  await handlers.createInvoice(req, second, raiseNext);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.invoice_id, first.body.invoice_id);
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("lookup settles invoice and publishes replayable SSE event", async () => {
  const { wallet, handlers } = createHarness();
  const createRes = createResponse();
  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-2"
      },
      body: {
        amount_msats: 200000,
        description: "Fruit sticker"
      }
    }),
    createRes,
    raiseNext
  );

  wallet.lookupState = "settled";
  const lookupRes = createResponse();
  await handlers.lookupInvoice(
    createRequest({
      body: {
        payment_hash: PAYMENT_HASH
      }
    }),
    lookupRes,
    raiseNext
  );

  assert.equal(lookupRes.statusCode, 200);
  assert.equal(lookupRes.body.transaction_state, "settled");
  assert.equal(lookupRes.body.workflow_state, "awaiting_fulfillment");
  assert.equal(lookupRes.body.preimage_present, true);

  const eventRes = createResponse();
  await handlers.invoiceEvents(
    createRequest({
      params: {
        invoice_id: createRes.body.invoice_id
      }
    }),
    eventRes,
    raiseNext
  );

  const stream = eventRes.writes.join("");
  assert.match(stream, /event: invoice\.created/);
  assert.match(stream, /event: invoice\.settled/);
  assert.match(stream, /: heartbeat/);
});

test("lookup rejects public status oracle requests for unknown payment hashes", async () => {
  const { handlers } = createHarness();
  const res = createResponse();
  await handlers.lookupInvoice(
    createRequest({
      body: {
        payment_hash: "0".repeat(64)
      }
    }),
    res,
    raiseNext
  );

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, "NOT_FOUND");
});

function createRequest(overrides = {}) {
  return {
    params: {},
    headers: {},
    body: {},
    get(name) {
      return this.headers[name.toLowerCase()] ?? this.headers[name];
    },
    ...overrides
  };
}

function createResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    writes: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(field, value) {
      this.headers[field.toLowerCase()] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    write(chunk) {
      this.writes.push(chunk);
      return true;
    },
    end() {
      return undefined;
    },
    flushHeaders() {
      return undefined;
    }
  };
}

function raiseNext(error) {
  if (error) throw error;
}
