import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryInvoiceKvStore
} from "../../packages/js/core/src/index.ts";
import {
  OpenReceiveServiceError,
  createOpenReceive
} from "../../packages/js/node/src/index.ts";

const PAYMENT_HASH = "e".repeat(64);

class FakeWallet {
  makeInvoiceCalls = 0;
  lookupInvoiceCalls = 0;
  lookupState = "pending";
  makeInvoiceError = undefined;
  expiresAt = 1600;

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
    const amountMsats = typeof request.amount_msats === "bigint"
      ? request.amount_msats
      : BigInt(request.amount_msats ?? request.amount);
    return {
      invoice: "lnbc-demo",
      payment_hash: PAYMENT_HASH,
      amount_msats: amountMsats,
      created_at: 1000,
      expires_at: this.expiresAt
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

async function createHarness(overrides = {}) {
  const wallet = overrides.client ?? new FakeWallet();
  const store = overrides.store ?? new InMemoryInvoiceKvStore();
  const openreceive = await createOpenReceive({
    client: wallet,
    store,
    namespace: "demo_hello_fruit",
    clock: () => 1000,
    backgroundSweep: false,
    ...overrides
  });

  return { wallet, store, openreceive };
}

test("create invoice uses idempotency replay without a second wallet call", async () => {
  const { wallet, openreceive } = await createHarness();
  const request = {
    orderUuid: "order-1",
    amount_msats: 200000,
    optionalInvoiceDescription: "Fruit sticker",
    expiry: 600
  };

  const first = await openreceive.createInvoice(request);
  assert.equal(first.transaction_state, "pending");

  const second = await openreceive.createInvoice(request);
  assert.equal(second.invoice_id, first.invoice_id);
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("create invoice does not expose a wallet expiry longer than requested", async () => {
  const { wallet, openreceive } = await createHarness();
  wallet.expiresAt = 4600;

  const invoice = await openreceive.createInvoice({
    orderUuid: "order-short-expiry",
    amount_msats: 200000,
    optionalInvoiceDescription: "Fruit sticker",
    expiry: 600
  });

  assert.equal(invoice.created_at, 1000);
  assert.equal(invoice.expires_at, 1600);
});

test("create invoice rejects idempotency key reuse with a different body", async () => {
  const { wallet, openreceive } = await createHarness();

  await openreceive.createInvoice({
    orderUuid: "order-create-conflict",
    amount_msats: 200000,
    optionalInvoiceDescription: "Fruit sticker"
  });

  await assertServiceError(
    () => openreceive.createInvoice({
      orderUuid: "order-create-conflict",
      amount_msats: 300000,
      optionalInvoiceDescription: "Fruit sticker"
    }),
    {
      status: 409,
      code: "CONFLICT",
      message: "Idempotency key was reused with a different request body."
    }
  );
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("create invoice quotes fiat with configured price providers", async () => {
  const calls = [];
  const liveProvider = {
    source: "openreceive_mirror",
    async getBtcFiatRates(currencies) {
      calls.push(currencies);
      return {
        bitcoin: {
          usd: "100000.00"
        }
      };
    }
  };
  const { wallet, openreceive } = await createHarness({
    priceProviders: [liveProvider],
    priceCurrencies: ["USD"]
  });

  const invoice = await openreceive.createInvoice({
    orderUuid: "order-live-rate",
    fiat: {
      currency: "USD",
      value: "0.05"
    },
    optionalInvoiceDescription: "Fruit sticker"
  });

  assert.equal(invoice.amount_msats, 50000);
  assert.equal(invoice.fiat_quote.amount_msats, 50000);
  assert.equal(invoice.fiat_quote.btc_fiat_price, "100000.00");
  assert.equal(invoice.fiat_quote.source, "openreceive_mirror");
  assert.equal(wallet.makeInvoiceCalls, 1);
  assert.deepEqual(calls, [["USD"]]);
});

test("create invoice accepts BTC and SATS amounts without price providers", async () => {
  const providerCalls = [];
  const provider = {
    source: "openreceive_mirror",
    async getBtcFiatRates(currencies) {
      providerCalls.push(currencies);
      throw new Error("direct Bitcoin amounts must not call price providers");
    }
  };
  const btcHarness = await createHarness({
    priceProviders: [provider],
    priceCurrencies: ["USD"]
  });

  const btcInvoice = await btcHarness.openreceive.createInvoice({
    orderUuid: "order-btc",
    amount: {
      currency: "BTC",
      value: "0.005"
    },
    optionalInvoiceDescription: "BTC amount"
  });
  assert.equal(btcInvoice.amount_msats, 500000000);

  const satsHarness = await createHarness({
    priceProviders: [provider],
    priceCurrencies: ["USD"]
  });
  const satsInvoice = await satsHarness.openreceive.createInvoice({
    orderUuid: "order-sats",
    amount: {
      currency: "SATS",
      value: "7000"
    },
    optionalInvoiceDescription: "SATS amount"
  });
  assert.equal(satsInvoice.amount_msats, 7000000);
  assert.equal(btcHarness.wallet.makeInvoiceCalls, 1);
  assert.equal(satsHarness.wallet.makeInvoiceCalls, 1);
  assert.deepEqual(providerCalls, []);
});

test("lookup settles invoice through gated backend refresh", async () => {
  const { wallet, openreceive } = await createHarness();
  const invoice = await openreceive.createInvoice({
    orderUuid: "order-2",
    amount_msats: 200000,
    optionalInvoiceDescription: "Fruit sticker"
  });

  wallet.lookupState = "settled";
  const lookup = await openreceive.lookupInvoice({
    payment_hash: PAYMENT_HASH
  });

  assert.equal(lookup.invoice_id, invoice.invoice_id);
  assert.equal(lookup.transaction_state, "settled");
  assert.equal(lookup.workflow_state, "settlement_action_completed");
  assert.equal(lookup.settlement_action_state, "completed");
  assert.equal(lookup.settled_at, 1200);
  assert.equal(lookup.preimage_present, true);
  assert.equal("checkout" in lookup, false);
});

test("logger records invoice transitions without secrets", async () => {
  const logs = [];
  const { wallet, openreceive } = await createHarness({
    logger: (entry) => {
      logs.push(entry);
    }
  });
  const invoice = await openreceive.createInvoice({
    orderUuid: "order-logged",
    amount_msats: 200000,
    optionalInvoiceDescription: "Fruit sticker"
  });

  wallet.lookupState = "settled";
  await openreceive.lookupInvoice({
    payment_hash: PAYMENT_HASH
  });

  assert.deepEqual(
    logs.map((entry) => entry.event),
    [
      "invoice.create.requested",
      "invoice.created",
      "invoice.lookup.requested",
      "invoice.settled",
      "invoice.settlement_action_completed",
      "invoice.lookup.result"
    ]
  );
  assert.equal(logs[1].invoice_id, invoice.invoice_id);
  assert.equal(logs[1].payment_hash, PAYMENT_HASH);
  assert.equal(logs[3].transaction_state, "settled");
  assert.doesNotMatch(JSON.stringify(logs), /nostr\+walletconnect:\/\//);
});

test("logger redacts wallet errors before emitting unhandled failures", async () => {
  const logs = [];
  const fakeNwc = `nostr+walletconnect://${"f".repeat(64)}?relay=wss%3A%2F%2Frelay.example.com&secret=${"a".repeat(64)}`;
  const { wallet, openreceive } = await createHarness({
    logger: (entry) => {
      logs.push(entry);
    }
  });
  wallet.makeInvoiceError = new Error(`wallet rejected ${fakeNwc}`);

  await assert.rejects(
    () => openreceive.createInvoice({
      orderUuid: "order-wallet-error",
      amount_msats: 200000,
      optionalInvoiceDescription: "Fruit sticker"
    }),
    /wallet rejected/
  );

  const errorLog = logs.find((entry) => entry.event === "service.error");
  assert.equal(errorLog.level, "error");
  assert.equal(errorLog.error_message, "wallet rejected [REDACTED_NWC]");
  assert.doesNotMatch(JSON.stringify(logs), /nostr\+walletconnect:\/\//);
  assert.doesNotMatch(JSON.stringify(logs), /a{64}/);
});

test("lookup can run an idempotent backend settlement action hook after settlement", async () => {
  let onPaidCalls = 0;
  const { wallet, openreceive } = await createHarness({
    clock: () => 1300,
    onPaid: async ({ invoice, orderUuid, metadata }) => {
      onPaidCalls += 1;
      assert.equal(invoice.transaction_state, "settled");
      assert.equal(orderUuid, "order-settlement-action");
      assert.deepEqual(metadata, { order_uuid: "order-settlement-action" });
    }
  });
  await openreceive.createInvoice({
    orderUuid: "order-settlement-action",
    amount_msats: 200000,
    optionalInvoiceDescription: "Fruit sticker"
  });

  wallet.lookupState = "settled";
  const firstLookup = await openreceive.lookupInvoice({
    payment_hash: PAYMENT_HASH
  });

  assert.equal(firstLookup.workflow_state, "settlement_action_completed");
  assert.equal(firstLookup.settlement_action_state, "completed");
  assert.equal(firstLookup.settlement_action_completed_at, 1300);
  assert.equal(onPaidCalls, 1);

  const secondLookup = await openreceive.lookupInvoice({
    payment_hash: PAYMENT_HASH
  });

  assert.equal(secondLookup.workflow_state, "settlement_action_completed");
  assert.equal(onPaidCalls, 1);
});

test("poll recovers invoices without browser polling", async () => {
  let onPaidCalls = 0;
  const settlementSources = [];
  const wallet = new FakeWallet();
  const store = new InMemoryInvoiceKvStore();
  const openreceive = await createOpenReceive({
    client: wallet,
    store,
    namespace: "demo_hello_fruit",
    backgroundSweep: false,
    clock: () => 1600,
    onPaid: async ({ invoice, source, req }) => {
      onPaidCalls += 1;
      settlementSources.push(source);
      assert.equal(req, undefined);
      assert.equal(invoice.transaction_state, "settled");
    }
  });

  const invoice = await openreceive.createInvoice({
    orderUuid: "order-runner",
    amount_msats: 200000,
    optionalInvoiceDescription: "Fruit sticker"
  });

  wallet.lookupState = "settled";
  const poll = await openreceive.poll();
  const stored = (await store.get(invoice.invoice_id)).row;

  assert.deepEqual(poll.invoice_ids, [invoice.invoice_id]);
  assert.equal(poll.checked, 1);
  assert.equal(onPaidCalls, 1);
  assert.deepEqual(settlementSources, ["poll"]);
  assert.equal(stored.workflow_state, "settlement_action_completed");
});

test("poll reads sweep tuning from env defaults", async () => {
  const previousSweepBatch = process.env.OPENRECEIVE_SWEEP_BATCH;
  process.env.OPENRECEIVE_SWEEP_BATCH = "1";

  try {
    const wallet = new FakeWallet();
    const store = new InMemoryInvoiceKvStore();
    await seedInvoice(store, {
      invoice_id: "or_inv_env_batch_1",
      idempotency_key: "env-batch-1",
      payment_hash: "1".repeat(64),
      invoice: "lnbc-env-batch-1"
    });
    await seedInvoice(store, {
      invoice_id: "or_inv_env_batch_2",
      idempotency_key: "env-batch-2",
      payment_hash: "2".repeat(64),
      invoice: "lnbc-env-batch-2"
    });

    wallet.lookupState = "settled";
    const openreceive = await createOpenReceive({
      client: wallet,
      store,
      namespace: "demo_hello_fruit",
      backgroundSweep: false,
      clock: () => 1600
    });

    const poll = await openreceive.poll();

    assert.deepEqual(poll.invoice_ids, ["or_inv_env_batch_1"]);
    assert.equal(poll.checked, 1);
    assert.equal(wallet.lookupInvoiceCalls, 1);
  } finally {
    restoreEnvVar("OPENRECEIVE_SWEEP_BATCH", previousSweepBatch);
  }
});

test("client-supplied settlement fields cannot trigger settlement action", async () => {
  let onPaidCalls = 0;
  const { wallet, store, openreceive } = await createHarness({
    clock: () => 1300,
    onPaid: async () => {
      onPaidCalls += 1;
    }
  });
  const invoice = await openreceive.createInvoice({
    orderUuid: "order-client-state",
    amount_msats: 200000,
    optionalInvoiceDescription: "Fruit sticker"
  });

  wallet.lookupState = "pending";
  const lookup = await openreceive.lookupInvoice({
    payment_hash: PAYMENT_HASH,
    transaction_state: "settled",
    settled_at: 1300,
    preimage: "1".repeat(64)
  });

  const stored = (await store.get(invoice.invoice_id)).row;
  assert.equal(lookup.transaction_state, "pending");
  assert.equal(lookup.workflow_state, "verifying");
  assert.equal(stored.transaction_state, "pending");
  assert.equal(stored.settlement_action_state, "pending");
  assert.equal(onPaidCalls, 0);
});

test("lookup rejects public status oracle requests for unknown payment hashes", async () => {
  const { openreceive } = await createHarness();

  await assertServiceError(
    () => openreceive.lookupInvoice({
      payment_hash: "0".repeat(64)
    }),
    {
      status: 404,
      code: "NOT_FOUND",
      message: "Invoice not found: " + "0".repeat(64)
    }
  );
});

test("read-only rate helpers expose static rates and quotes", async () => {
  const { openreceive } = await createHarness();

  const rates = await openreceive.listRates();
  assert.equal(rates.bitcoin.usd, "50000.00");

  const quote = await openreceive.quoteRates({
    fiat: {
      currency: "USD",
      value: "0.10"
    }
  });
  assert.equal(quote.amount_msats, 200000);
  assert.equal(quote.source, "static_mock");

  await assertServiceError(
    () => openreceive.quoteRates({
      fiat: {
        currency: "EUR",
        value: "0.10"
      }
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "fiat.currency must be one of the configured priceCurrencies: USD."
    }
  );
});

test("create invoice rejects fiat currencies outside configured priceCurrencies", async () => {
  const providerCalls = [];
  const provider = {
    source: "openreceive_mirror",
    async getBtcFiatRates(currencies) {
      providerCalls.push(currencies);
      return {
        bitcoin: {
          eur: "90000.00"
        }
      };
    }
  };
  const { wallet, openreceive } = await createHarness({
    priceProviders: [provider],
    priceCurrencies: ["USD"]
  });

  await assertServiceError(
    () => openreceive.createInvoice({
      orderUuid: "order-eur-denied",
      fiat: {
        currency: "EUR",
        value: "0.10"
      },
      optionalInvoiceDescription: "Fruit sticker"
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "fiat.currency must be one of the configured priceCurrencies: USD."
    }
  );

  assert.equal(wallet.makeInvoiceCalls, 0);
  assert.deepEqual(providerCalls, []);
});

test("rate helpers use configured price providers", async () => {
  const provider = {
    source: "megalithic_mirror",
    async getBtcFiatRates(currencies) {
      assert.deepEqual(currencies, ["USD"]);
      return {
        bitcoin: {
          usd: "125000.00"
        }
      };
    }
  };
  const { openreceive } = await createHarness({
    priceProviders: [provider],
    priceCurrencies: ["USD"]
  });

  const rates = await openreceive.listRates();
  assert.equal(rates.bitcoin.usd, "125000.00");

  const quote = await openreceive.quoteRates({
    fiat: {
      currency: "USD",
      value: "0.05"
    }
  });
  assert.equal(quote.amount_msats, 40000);
  assert.equal(quote.source, "megalithic_mirror");
});

test("create invoice rejects description and description_hash together", async () => {
  const { wallet, openreceive } = await createHarness();

  await assertServiceError(
    () => openreceive.createInvoice({
      orderUuid: "order-description-conflict",
      amount_msats: 200000,
      optionalInvoiceDescription: "Fruit sticker",
      description_hash: "a".repeat(64)
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Create invoice request accepts only one of optionalInvoiceDescription or description_hash."
    }
  );
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("create invoice rejects invalid description_hash before wallet call", async () => {
  const { wallet, openreceive } = await createHarness();

  await assertServiceError(
    () => openreceive.createInvoice({
      orderUuid: "order-description-hash",
      amount_msats: 200000,
      description_hash: "not-hex"
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "description_hash must be 64 hex characters."
    }
  );
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("create invoice rejects invalid fiat quote before wallet call", async () => {
  const { wallet, openreceive } = await createHarness();

  await assertServiceError(
    () => openreceive.createInvoice({
      orderUuid: "order-invalid-fiat",
      fiat: {
        currency: "usd",
        value: "0.10"
      },
      optionalInvoiceDescription: "Fruit sticker"
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "fiat.currency must be an ISO 4217 uppercase code"
    }
  );
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("refresh invoice creates a linked replacement and replays idempotently", async () => {
  const { wallet, store, openreceive } = await createHarness();
  const oldInvoice = await seedInvoice(store, {
    invoice_id: "or_inv_old",
    payment_hash: "d".repeat(64),
    invoice: "lnbc-old",
    transaction_state: "expired",
    workflow_state: "expired_closed",
    metadata: {
      order_id: "order-1"
    }
  });
  const request = {
    idempotency_key: "refresh-1",
    reason: "expired"
  };

  const first = await openreceive.refreshInvoice(oldInvoice.invoice_id, request);
  assert.equal(first.old_invoice_id, oldInvoice.invoice_id);
  assert.equal(first.reason, "expired");
  assert.equal(first.invoice.refreshed_from_invoice_id, oldInvoice.invoice_id);
  assert.equal(first.invoice.transaction_state, "pending");

  const second = await openreceive.refreshInvoice(oldInvoice.invoice_id, request);
  assert.equal(second.new_invoice_id, first.new_invoice_id);
  assert.equal(wallet.makeInvoiceCalls, 1);

  const storedOld = (await store.get(oldInvoice.invoice_id)).row;
  const storedNew = (await store.get(first.new_invoice_id)).row;
  assert.equal(storedOld.transaction_state, "expired");
  assert.equal(storedOld.workflow_state, "expired_closed");
  assert.equal(storedNew.operation, "invoice.refresh");
  assert.equal(storedNew.refreshed_from_invoice_id, oldInvoice.invoice_id);
  assert.deepEqual(storedNew.metadata, { order_id: "order-1" });
});

test("refresh invoice rejects idempotency key reuse with a different body", async () => {
  const { wallet, store, openreceive } = await createHarness();
  const oldInvoice = await seedInvoice(store, {
    invoice_id: "or_inv_refresh_conflict",
    payment_hash: "c".repeat(64),
    invoice: "lnbc-refresh-conflict",
    transaction_state: "expired",
    workflow_state: "expired_closed"
  });

  await openreceive.refreshInvoice(oldInvoice.invoice_id, {
    idempotency_key: "refresh-conflict",
    reason: "expired"
  });

  await assertServiceError(
    () => openreceive.refreshInvoice(oldInvoice.invoice_id, {
      idempotency_key: "refresh-conflict",
      reason: "failed"
    }),
    {
      status: 409,
      code: "CONFLICT",
      message: "Idempotency key was reused with a different request body."
    }
  );
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("refresh invoice rejects settled invoices before wallet call", async () => {
  const { wallet, store, openreceive } = await createHarness();
  const settledInvoice = await seedInvoice(store, {
    invoice_id: "or_inv_settled",
    transaction_state: "settled",
    workflow_state: "settlement_action_pending",
    settled_at: 1100
  });

  await assertServiceError(
    () => openreceive.refreshInvoice(settledInvoice.invoice_id, {
      idempotency_key: "refresh-settled",
      reason: "expired"
    }),
    {
      status: 409,
      code: "CONFLICT",
      message: "Invoice can only be refreshed after it expires or fails."
    }
  );
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("refresh invoice requires idempotency_key as service input", async () => {
  const { store, openreceive } = await createHarness();
  const oldInvoice = await seedInvoice(store, {
    invoice_id: "or_inv_refresh_no_key",
    transaction_state: "expired",
    workflow_state: "expired_closed"
  });

  await assertServiceError(
    () => openreceive.refreshInvoice(oldInvoice.invoice_id, {
      reason: "expired"
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "idempotency_key is required."
    }
  );
});

test("host apps own routes, guards, and response policy around OpenReceive service methods", async () => {
  const { wallet, openreceive } = await createHarness();
  const guardedCreate = async (request) => {
    if (request.user?.id === undefined) {
      return {
        status: 403,
        body: {
          code: "UNAUTHORIZED",
          message: "App route is not authorized."
        }
      };
    }

    return {
      status: 201,
      body: await openreceive.createInvoice(request.body)
    };
  };

  const denied = await guardedCreate({
    body: {
      orderUuid: "order-denied",
      amount_msats: 200000
    }
  });
  assert.equal(denied.status, 403);
  assert.equal(wallet.makeInvoiceCalls, 0);

  const allowed = await guardedCreate({
    user: {
      id: "alice"
    },
    body: {
      orderUuid: "order-allowed",
      amount_msats: 200000
    }
  });
  assert.equal(allowed.status, 201);
  assert.equal(wallet.makeInvoiceCalls, 1);

  const read = await openreceive.getInvoice(allowed.body.invoice_id);
  assert.equal(read.invoice_id, allowed.body.invoice_id);
});

test("createOpenReceive refuses in-memory invoice storage in production mode", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOpenReceiveMode = process.env.OPENRECEIVE_MODE;
  process.env.NODE_ENV = "production";
  delete process.env.OPENRECEIVE_MODE;

  try {
    const options = {
      client: new FakeWallet(),
      store: new InMemoryInvoiceKvStore(),
      namespace: "demo_hello_fruit",
      backgroundSweep: false
    };

    await assert.rejects(
      () => createOpenReceive(options),
      /refuses to use InMemoryInvoiceKvStore/
    );
    await assert.rejects(
      () => createOpenReceive({
        ...options,
        store: undefined,
        storeUri: "memory:"
      }),
      /refuses to use InMemoryInvoiceKvStore/
    );
  } finally {
    restoreEnvVar("NODE_ENV", originalNodeEnv);
    restoreEnvVar("OPENRECEIVE_MODE", originalOpenReceiveMode);
  }
});

async function assertServiceError(action, expected) {
  await assert.rejects(
    action,
    (error) => {
      assert.equal(error instanceof OpenReceiveServiceError, true);
      assert.equal(error.status, expected.status);
      assert.equal(error.body.code, expected.code);
      assert.equal(error.body.message, expected.message);
      return true;
    }
  );
}

async function seedInvoice(store, overrides = {}) {
  const row = {
    invoice_id: "or_inv_seed",
    namespace: "demo:hello-fruit",
    operation: "invoice.create",
    idempotency_key: "seed",
    idempotency_request_hash: `sha256:${"0".repeat(64)}`,
    payment_hash: PAYMENT_HASH,
    invoice: "lnbc-demo",
    amount_msats: 200000,
    transaction_state: "pending",
    workflow_state: "invoice_created",
    settlement_action_state: "pending",
    created_at: 1000,
    expires_at: 1600,
    metadata: {},
    ...overrides
  };
  await store.putIfAbsent({ rev: 0, row });
  return row;
}

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
