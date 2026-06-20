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
  lookupInvoiceCalls = 0;
  lookupState = "pending";
  makeInvoiceError = undefined;

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
    if (this.makeInvoiceError !== undefined) {
      throw this.makeInvoiceError;
    }
    return {
      invoice: "lnbc-demo",
      payment_hash: PAYMENT_HASH,
      amount_msats: BigInt(request.amount_msats ?? request.amount),
      created_at: 1000,
      expires_at: 1600
    };
  }

  async lookupInvoice() {
    this.lookupInvoiceCalls += 1;
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

function createHarness(overrides = {}) {
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
    heartbeatSeconds: 1,
    ...overrides
  });

  return { wallet, store, eventBus, handlers };
}

function createSecureHarness(overrides = {}) {
  const wallet = new FakeWallet();
  const store = new InMemoryInvoiceStore();
  const eventBus = new InMemoryInvoiceEventBus();
  const handlers = createOpenReceiveExpressHandlers({
    client: wallet,
    store,
    eventBus,
    merchantScope: () => "demo:hello-fruit",
    clock: () => 1000,
    heartbeatSeconds: 1,
    ...overrides
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

test("create invoice rejects idempotency key reuse with a different body", async () => {
  const { wallet, handlers } = createHarness();

  const first = createResponse();
  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-create-conflict"
      },
      body: {
        amount_msats: 200000,
        description: "Fruit sticker"
      }
    }),
    first,
    raiseNext
  );
  assert.equal(first.statusCode, 201);

  const conflict = createResponse();
  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-create-conflict"
      },
      body: {
        amount_msats: 300000,
        description: "Fruit sticker"
      }
    }),
    conflict,
    raiseNext
  );

  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, "CONFLICT");
  assert.equal(
    conflict.body.message,
    "Idempotency key was reused with a different request body."
  );
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
  assert.equal(lookupRes.body.settled_at, 1200);
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
  assert.match(stream, /event: invoice\.verifying/);
  assert.match(stream, /event: invoice\.settled/);
  assert.match(stream, /: heartbeat/);
});

test("logger records invoice transitions without secrets or signed event tokens", async () => {
  const logs = [];
  const { wallet, handlers } = createHarness({
    logger: (entry) => {
      logs.push(entry);
    },
    signedEvents: {
      secret: "s".repeat(32)
    }
  });
  const createRes = createResponse();
  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-logged"
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

  const eventUrl = new URL(
    createRes.body.checkout.events_url,
    "https://shop.example"
  );
  const eventToken = eventUrl.searchParams.get("_or_evt");
  const eventRes = createResponse();
  await handlers.invoiceEvents(
    createRequest({
      params: {
        invoice_id: createRes.body.invoice_id
      },
      query: {
        _or_evt: eventToken
      }
    }),
    eventRes,
    raiseNext
  );

  assert.deepEqual(
    logs.map((entry) => entry.event),
    [
      "invoice.create.requested",
      "invoice.created",
      "invoice.lookup.requested",
      "invoice.verifying",
      "invoice.settled",
      "invoice.events.opened",
      "invoice.events.closed"
    ]
  );
  assert.equal(logs[1].invoice_id, createRes.body.invoice_id);
  assert.equal(logs[1].payment_hash, PAYMENT_HASH);
  assert.equal(logs[4].transaction_state, "settled");
  assert.equal(logs[5].replayed_events, 3);

  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, /nostr\+walletconnect:\/\//);
  assert.doesNotMatch(serializedLogs, /_or_evt=/);
  assert.doesNotMatch(serializedLogs, /s{32}/);
});

test("logger redacts wallet errors before emitting unhandled failures", async () => {
  const logs = [];
  const fakeNwc = `nostr+walletconnect://${"f".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"a".repeat(64)}`;
  const { wallet, handlers } = createHarness({
    logger: (entry) => {
      logs.push(entry);
    }
  });
  wallet.makeInvoiceError = new Error(`wallet rejected ${fakeNwc}`);

  await assert.rejects(
    () => handlers.createInvoice(
      createRequest({
        headers: {
          "idempotency-key": "order-wallet-error"
        },
        body: {
          amount_msats: 200000,
          description: "Fruit sticker"
        }
      }),
      createResponse(),
      raiseNext
    ),
    /wallet rejected/
  );

  const errorLog = logs.find((entry) => entry.event === "handler.error");
  assert.equal(errorLog.level, "error");
  assert.equal(errorLog.error_message, "wallet rejected [REDACTED_NWC]");
  assert.doesNotMatch(JSON.stringify(logs), /nostr\+walletconnect:\/\//);
  assert.doesNotMatch(JSON.stringify(logs), /a{64}/);
});

test("signed event URLs authorize one invoice and expire", async () => {
  let now = 1000;
  const { handlers, store } = createSecureHarness({
    clock: () => now,
    auth: {
      create: () => true
    },
    signedEvents: {
      secret: "s".repeat(32),
      ttlSeconds: 60
    }
  });

  const createRes = createResponse();
  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-signed-events"
      },
      body: {
        amount_msats: 200000,
        description: "Fruit sticker"
      }
    }),
    createRes,
    raiseNext
  );

  assert.equal(createRes.statusCode, 201);
  assert.match(createRes.body.checkout.events_url, /_or_evt=/);
  assert.doesNotMatch(createRes.body.checkout.events_url, /secret|token/i);
  assert.doesNotMatch(createRes.body.checkout.events_url, /s{32}/);

  const eventUrl = new URL(
    createRes.body.checkout.events_url,
    "https://shop.example"
  );
  const eventToken = eventUrl.searchParams.get("_or_evt");
  assert.equal(typeof eventToken, "string");

  const eventRes = createResponse();
  await handlers.invoiceEvents(
    createRequest({
      params: {
        invoice_id: createRes.body.invoice_id
      },
      query: {
        _or_evt: eventToken
      }
    }),
    eventRes,
    raiseNext
  );

  assert.equal(eventRes.statusCode, 200);
  assert.match(eventRes.writes.join(""), /event: invoice\.created/);

  seedInvoice(store, {
    invoice_id: "or_inv_other",
    payment_hash: "f".repeat(64),
    invoice: "lnbc-other"
  });
  const wrongInvoiceRes = createResponse();
  await handlers.invoiceEvents(
    createRequest({
      params: {
        invoice_id: "or_inv_other"
      },
      query: {
        _or_evt: eventToken
      }
    }),
    wrongInvoiceRes,
    raiseNext
  );

  assert.equal(wrongInvoiceRes.statusCode, 403);
  assert.equal(wrongInvoiceRes.body.message, "Signed event URL is invalid or expired.");

  now = 1061;
  const expiredRes = createResponse();
  await handlers.invoiceEvents(
    createRequest({
      params: {
        invoice_id: createRes.body.invoice_id
      },
      query: {
        _or_evt: eventToken
      }
    }),
    expiredRes,
    raiseNext
  );

  assert.equal(expiredRes.statusCode, 403);
  assert.equal(expiredRes.body.message, "Signed event URL is invalid or expired.");
});

test("lookup can run an idempotent backend fulfillment hook after settlement", async () => {
  let fulfillCalls = 0;
  const { wallet, handlers } = createHarness({
    clock: () => 1300,
    fulfill: async ({ invoice, metadata }) => {
      fulfillCalls += 1;
      assert.equal(invoice.transaction_state, "settled");
      assert.deepEqual(metadata, { fruit: "pear" });
    }
  });
  const createRes = createResponse();
  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-fulfill"
      },
      body: {
        amount_msats: 200000,
        description: "Fruit sticker",
        metadata: {
          fruit: "pear"
        }
      }
    }),
    createRes,
    raiseNext
  );

  wallet.lookupState = "settled";
  const firstLookup = createResponse();
  await handlers.lookupInvoice(
    createRequest({
      body: {
        payment_hash: PAYMENT_HASH
      }
    }),
    firstLookup,
    raiseNext
  );

  assert.equal(firstLookup.statusCode, 200);
  assert.equal(firstLookup.body.workflow_state, "fulfilled");
  assert.equal(firstLookup.body.fulfillment.state, "delivered");
  assert.equal(firstLookup.body.fulfilled_at, 1300);
  assert.equal(fulfillCalls, 1);

  const secondLookup = createResponse();
  await handlers.lookupInvoice(
    createRequest({
      body: {
        payment_hash: PAYMENT_HASH
      }
    }),
    secondLookup,
    raiseNext
  );

  assert.equal(secondLookup.body.workflow_state, "fulfilled");
  assert.equal(fulfillCalls, 1);

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
  assert.match(stream, /event: invoice\.settled/);
  assert.match(stream, /event: invoice\.fulfilled/);
});

test("client-supplied settlement fields cannot trigger fulfillment", async () => {
  let fulfillCalls = 0;
  const { wallet, store, handlers } = createHarness({
    clock: () => 1300,
    fulfill: async () => {
      fulfillCalls += 1;
    }
  });
  const createRes = createResponse();
  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-client-state"
      },
      body: {
        amount_msats: 200000,
        description: "Fruit sticker"
      }
    }),
    createRes,
    raiseNext
  );

  wallet.lookupState = "pending";
  const lookupRes = createResponse();
  await handlers.lookupInvoice(
    createRequest({
      body: {
        payment_hash: PAYMENT_HASH,
        transaction_state: "settled",
        settled_at: 1300,
        preimage: "1".repeat(64)
      }
    }),
    lookupRes,
    raiseNext
  );

  const stored = store.getInvoice(createRes.body.invoice_id);
  assert.equal(lookupRes.statusCode, 200);
  assert.equal(lookupRes.body.transaction_state, "pending");
  // A lookup is the server verifying via lookup_invoice, so the workflow moves
  // invoice_created -> verifying. Crucially, the unverified (still pending)
  // wallet result keeps transaction_state pending and never fulfills, even
  // though the client put settlement fields in the request body.
  assert.equal(lookupRes.body.workflow_state, "verifying");
  assert.equal(stored.transaction_state, "pending");
  assert.equal(stored.fulfillment_state, "pending");
  assert.equal(fulfillCalls, 0);
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

test("read-only helper routes expose static rates, providers, and route suggestions", async () => {
  const { handlers } = createHarness();

  const ratesRes = createResponse();
  await handlers.listRates(createRequest(), ratesRes, raiseNext);
  assert.equal(ratesRes.statusCode, 200);
  assert.equal(ratesRes.body.bitcoin.usd, "50000.00");

  const quoteRes = createResponse();
  await handlers.quoteRates(
    createRequest({
      body: {
        fiat: {
          currency: "USD",
          value: "0.10"
        }
      }
    }),
    quoteRes,
    raiseNext
  );
  assert.equal(quoteRes.statusCode, 200);
  assert.equal(quoteRes.body.amount_msats, 200000);
  assert.equal(quoteRes.body.source, "static_mock");

  const missingRateRes = createResponse();
  await handlers.quoteRates(
    createRequest({
      body: {
        fiat: {
          currency: "EUR",
          value: "0.10"
        }
      }
    }),
    missingRateRes,
    raiseNext
  );
  assert.equal(missingRateRes.statusCode, 400);
  assert.equal(missingRateRes.body.code, "INVALID_REQUEST");
  assert.equal(missingRateRes.body.message, "unsupported static fiat currency: EUR");

  const providersRes = createResponse();
  await handlers.listProviders(
    createRequest({
      query: {
        us: "true"
      }
    }),
    providersRes,
    raiseNext
  );
  assert.equal(providersRes.statusCode, 200);
  assert.equal(providersRes.body.metadata.schema_version, "2.0.0");
  assert.equal(providersRes.body.providers.every((provider) => provider.us === true), true);

  const catalogRes = createResponse();
  await handlers.listRoutes(createRequest(), catalogRes, raiseNext);
  assert.equal(catalogRes.statusCode, 200);
  assert.equal(catalogRes.body.assets.length, 18);
  assert.equal(catalogRes.body.crypto_routes.length, 15);

  const wizardRes = createResponse();
  await handlers.listRoutes(
    createRequest({
      query: {
        asset: "BTC"
      }
    }),
    wizardRes,
    raiseNext
  );
  assert.equal(wizardRes.statusCode, 200);
  assert.equal(wizardRes.body.routes[0].kind, "crypto");
  assert.equal(wizardRes.body.routes[0].route.id, "btc-lightning");

  const capabilitiesRes = createResponse();
  await handlers.capabilities(createRequest(), capabilitiesRes, raiseNext);
  assert.equal(capabilitiesRes.statusCode, 200);
  assert.deepEqual(capabilitiesRes.body.methods, ["make_invoice", "lookup_invoice"]);
  assert.equal(capabilitiesRes.body.methods.includes("get_balance"), false);
});

test("provider route rejects invalid us filter", async () => {
  const { handlers } = createHarness();
  const res = createResponse();

  await handlers.listProviders(
    createRequest({
      query: {
        us: "maybe"
      }
    }),
    res,
    raiseNext
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "us filter must be true, false, unknown, or null.");
});

test("create invoice rejects description and description_hash together", async () => {
  const { wallet, handlers } = createHarness();
  const res = createResponse();

  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-description-conflict"
      },
      body: {
        amount_msats: 200000,
        description: "Fruit sticker",
        description_hash: "a".repeat(64)
      }
    }),
    res,
    raiseNext
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "Create invoice request accepts only one of description or description_hash.");
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("create invoice rejects invalid description_hash before wallet call", async () => {
  const { wallet, handlers } = createHarness();
  const res = createResponse();

  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-description-hash"
      },
      body: {
        amount_msats: 200000,
        description_hash: "not-hex"
      }
    }),
    res,
    raiseNext
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, "description_hash must be 64 hex characters.");
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("create invoice rejects invalid fiat quote before wallet call", async () => {
  const { wallet, handlers } = createHarness();
  const res = createResponse();

  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-invalid-fiat"
      },
      body: {
        fiat: {
          currency: "usd",
          value: "0.10"
        },
        description: "Fruit sticker"
      }
    }),
    res,
    raiseNext
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, "INVALID_REQUEST");
  assert.equal(res.body.message, "fiat.currency must be an ISO 4217 uppercase code");
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("refresh invoice creates a linked replacement and replays idempotently", async () => {
  const { wallet, store, handlers } = createHarness();
  const oldInvoice = seedInvoice(store, {
    invoice_id: "or_inv_old",
    payment_hash: "d".repeat(64),
    invoice: "lnbc-old",
    transaction_state: "expired",
    workflow_state: "expired_closed",
    metadata: {
      order_id: "order-1"
    }
  });
  const req = createRequest({
    params: {
      invoice_id: oldInvoice.invoice_id
    },
    headers: {
      "idempotency-key": "refresh-1"
    },
    body: {
      reason: "expired"
    }
  });

  const first = createResponse();
  await handlers.refreshInvoice(req, first, raiseNext);
  assert.equal(first.statusCode, 201);
  assert.equal(first.body.old_invoice_id, oldInvoice.invoice_id);
  assert.equal(first.body.reason, "expired");
  assert.equal(first.body.invoice.refreshed_from_invoice_id, oldInvoice.invoice_id);
  assert.equal(first.body.invoice.transaction_state, "pending");

  const second = createResponse();
  await handlers.refreshInvoice(req, second, raiseNext);
  assert.equal(second.statusCode, 200);
  assert.equal(second.body.new_invoice_id, first.body.new_invoice_id);
  assert.equal(wallet.makeInvoiceCalls, 1);

  const storedOld = store.getInvoice(oldInvoice.invoice_id);
  const storedNew = store.getInvoice(first.body.new_invoice_id);
  assert.equal(storedOld.transaction_state, "expired");
  assert.equal(storedOld.workflow_state, "expired_closed");
  assert.equal(storedNew.operation, "invoice.refresh");
  assert.equal(storedNew.refreshed_from_invoice_id, oldInvoice.invoice_id);
  assert.deepEqual(storedNew.metadata, { order_id: "order-1" });
});

test("refresh invoice rejects idempotency key reuse with a different body", async () => {
  const { wallet, store, handlers } = createHarness();
  const oldInvoice = seedInvoice(store, {
    invoice_id: "or_inv_refresh_conflict",
    payment_hash: "c".repeat(64),
    invoice: "lnbc-refresh-conflict",
    transaction_state: "expired",
    workflow_state: "expired_closed"
  });

  const first = createResponse();
  await handlers.refreshInvoice(
    createRequest({
      params: {
        invoice_id: oldInvoice.invoice_id
      },
      headers: {
        "idempotency-key": "refresh-conflict"
      },
      body: {
        reason: "expired"
      }
    }),
    first,
    raiseNext
  );
  assert.equal(first.statusCode, 201);

  const conflict = createResponse();
  await handlers.refreshInvoice(
    createRequest({
      params: {
        invoice_id: oldInvoice.invoice_id
      },
      headers: {
        "idempotency-key": "refresh-conflict"
      },
      body: {
        reason: "failed"
      }
    }),
    conflict,
    raiseNext
  );

  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.body.code, "CONFLICT");
  assert.equal(
    conflict.body.message,
    "Idempotency key was reused with a different request body."
  );
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("refresh invoice rejects settled invoices before wallet call", async () => {
  const { wallet, store, handlers } = createHarness();
  const settledInvoice = seedInvoice(store, {
    invoice_id: "or_inv_settled",
    transaction_state: "settled",
    workflow_state: "awaiting_fulfillment",
    settled_at: 1100
  });
  const res = createResponse();

  await handlers.refreshInvoice(
    createRequest({
      params: {
        invoice_id: settledInvoice.invoice_id
      },
      headers: {
        "idempotency-key": "refresh-settled"
      },
      body: {
        reason: "expired"
      }
    }),
    res,
    raiseNext
  );

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.message, "Invoice can only be refreshed after it expires or fails.");
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("secure Express handlers fail closed when auth hooks are missing", async () => {
  const { wallet, store, handlers } = createSecureHarness();
  seedInvoice(store);

  const createRes = createResponse();
  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-auth"
      },
      body: {
        amount_msats: 200000,
        description: "Fruit sticker"
      }
    }),
    createRes,
    raiseNext
  );

  assert.equal(createRes.statusCode, 401);
  assert.equal(createRes.body.message, "OpenReceive create authorization hook is required.");
  assert.equal(wallet.makeInvoiceCalls, 0);

  const readRes = createResponse();
  await handlers.getInvoice(
    createRequest({
      params: {
        invoice_id: "or_inv_seed"
      }
    }),
    readRes,
    raiseNext
  );

  assert.equal(readRes.statusCode, 401);
  assert.equal(readRes.body.message, "OpenReceive read authorization hook is required.");

  const eventsRes = createResponse();
  await handlers.invoiceEvents(
    createRequest({
      params: {
        invoice_id: "or_inv_seed"
      }
    }),
    eventsRes,
    raiseNext
  );

  assert.equal(eventsRes.statusCode, 401);
  assert.equal(eventsRes.body.message, "OpenReceive events authorization hook is required.");

  const refreshRes = createResponse();
  await handlers.refreshInvoice(
    createRequest({
      params: {
        invoice_id: "or_inv_seed"
      },
      headers: {
        "idempotency-key": "refresh-auth"
      },
      body: {
        reason: "expired"
      }
    }),
    refreshRes,
    raiseNext
  );

  assert.equal(refreshRes.statusCode, 401);
  assert.equal(refreshRes.body.message, "OpenReceive refresh authorization hook is required.");
});

test("secure Express handlers reject denied create authorization", async () => {
  const { wallet, handlers } = createSecureHarness({
    auth: {
      create: () => false
    }
  });
  const res = createResponse();

  await handlers.createInvoice(
    createRequest({
      headers: {
        "idempotency-key": "order-denied"
      },
      body: {
        amount_msats: 200000,
        description: "Fruit sticker"
      }
    }),
    res,
    raiseNext
  );

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message, "OpenReceive request is not authorized.");
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("secure Express handlers reject cross-session invoice access", async () => {
  const ownsInvoice = (req, invoice) => invoice.metadata.owner_id === req.user?.id;
  const { wallet, store, handlers } = createSecureHarness({
    auth: {
      read: ownsInvoice,
      lookup: ownsInvoice,
      events: ownsInvoice,
      refresh: ownsInvoice
    }
  });
  seedInvoice(store, {
    metadata: {
      owner_id: "alice"
    }
  });

  const readRes = createResponse();
  await handlers.getInvoice(
    createRequest({
      params: {
        invoice_id: "or_inv_seed"
      },
      user: {
        id: "bob"
      }
    }),
    readRes,
    raiseNext
  );

  assert.equal(readRes.statusCode, 403);
  assert.equal(readRes.body.message, "OpenReceive request is not authorized.");

  const lookupRes = createResponse();
  await handlers.lookupInvoice(
    createRequest({
      body: {
        payment_hash: PAYMENT_HASH
      },
      user: {
        id: "bob"
      }
    }),
    lookupRes,
    raiseNext
  );

  assert.equal(lookupRes.statusCode, 403);
  assert.equal(lookupRes.body.message, "OpenReceive request is not authorized.");
  assert.equal(wallet.lookupInvoiceCalls, 0);

  const eventsRes = createResponse();
  await handlers.invoiceEvents(
    createRequest({
      params: {
        invoice_id: "or_inv_seed"
      },
      user: {
        id: "bob"
      }
    }),
    eventsRes,
    raiseNext
  );

  assert.equal(eventsRes.statusCode, 403);
  assert.equal(eventsRes.body.message, "OpenReceive request is not authorized.");
  assert.deepEqual(eventsRes.writes, []);

  const refreshRes = createResponse();
  await handlers.refreshInvoice(
    createRequest({
      params: {
        invoice_id: "or_inv_seed"
      },
      headers: {
        "idempotency-key": "refresh-cross-session"
      },
      body: {
        reason: "expired"
      },
      user: {
        id: "bob"
      }
    }),
    refreshRes,
    raiseNext
  );

  assert.equal(refreshRes.statusCode, 403);
  assert.equal(refreshRes.body.message, "OpenReceive request is not authorized.");
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("lookup invoice requires csrf when configured", async () => {
  const { wallet, store, handlers } = createSecureHarness({
    auth: {
      lookup: () => true
    },
    csrf: {
      verify: () => false
    }
  });
  seedInvoice(store);
  const res = createResponse();

  await handlers.lookupInvoice(
    createRequest({
      body: {
        payment_hash: PAYMENT_HASH
      }
    }),
    res,
    raiseNext
  );

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.message, "CSRF verification failed.");
  assert.equal(wallet.lookupInvoiceCalls, 0);
});

function seedInvoice(store, overrides = {}) {
  const row = {
    invoice_id: "or_inv_seed",
    merchant_scope: "demo:hello-fruit",
    operation: "invoice.create",
    idempotency_key: "seed",
    idempotency_request_hash: `sha256:${"0".repeat(64)}`,
    payment_hash: PAYMENT_HASH,
    invoice: "lnbc-demo",
    amount_msats: 200000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    fulfillment_state: "pending",
    created_at: 1000,
    expires_at: 1600,
    metadata: {},
    ...overrides
  };
  store.createInvoice(row);
  return row;
}

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
