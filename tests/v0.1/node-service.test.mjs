import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryInvoiceKvStore,
  StaticPriceProvider
} from "../../packages/js/core/src/index.ts";
import {
  OpenReceiveConfigError,
  OpenReceiveServiceError,
  createOpenReceive
} from "../../packages/js/node/src/index.ts";

const PAYMENT_HASH = "e".repeat(64);

class FakeWallet {
  makeInvoiceCalls = 0;
  listTransactionsCalls = 0;
  transactionState = "pending";
  makeInvoiceError = undefined;
  expiresAt = 1600;

  async preflight() {
    return {
      walletPubkey: "f".repeat(64),
      relays: ["wss://relay.example.com"],
      methods: ["make_invoice", "list_transactions"],
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

  async listTransactions(request) {
    this.listTransactionsCalls += 1;
    if (request.type === "outgoing" || request.from > 1000 || request.until < 1000) {
      return { transactions: [] };
    }
    return {
      transactions: [{
        type: "incoming",
        invoice: "lnbc-demo",
        payment_hash: PAYMENT_HASH,
        amount_msats: 200000n,
        state: this.transactionState,
        settled_at: this.transactionState === "settled" ? 1200 : undefined,
        preimage: this.transactionState === "settled" ? "1".repeat(64) : undefined
      }].slice(request.offset ?? 0, (request.offset ?? 0) + (request.limit ?? 20))
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
    priceProviders: [new StaticPriceProvider()],
    ...overrides
  });

  return { wallet, store, openreceive };
}

test("create invoice uses idempotency replay without a second wallet call", async () => {
  const { wallet, openreceive } = await createHarness();
  const request = {
    orderId: "order-1",
    amount: { msats: 200000 },
    memo: "Fruit sticker",
    expiresInSeconds: 600
  };

  const first = await openreceive.createInvoice(request);
  assert.equal(first.transactionState, "pending");
  assert.equal(first.status, "pending");
  assert.equal(first.orderId, "order-1");
  assert.equal(first.amountMsats, 200000);

  const second = await openreceive.createInvoice(request);
  assert.equal(second.invoiceId, first.invoiceId);
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("createOpenReceive defaults to live cached price data and fails unhealthy boot", async () => {
  const store = new InMemoryInvoiceKvStore();

  await assert.rejects(
    () => createOpenReceive({
      client: new FakeWallet(),
      store,
      namespace: "demo_hello_fruit",
      priceFetch: async () => ({
        ok: false,
        status: 503,
        text: async () => "{}"
      })
    }),
    (error) => {
      assert.equal(error instanceof OpenReceiveConfigError, true);
      assert.equal(error.code, "UNHEALTHY_PRICE_DATA");
      return true;
    }
  );
});

test("diagnostic events and logger entries are sanitized and non-blocking", async () => {
  const events = [];
  const logs = [];
  const wallet = new FakeWallet();
  wallet.makeInvoiceError = new Error("wallet failed with https://example.test/path?token=abc123&ok=1");
  const { openreceive } = await createHarness({
    client: wallet,
    onEvent: (event) => {
      events.push(event);
      if (event.event === "service.error") throw new Error("event sink is down");
    },
    logger: (entry) => logs.push(entry)
  });

  await assert.rejects(
    () => openreceive.createInvoice({
      orderId: "order-diagnostics",
      amount: { msats: 200000 },
      memo: "Fruit sticker"
    }),
    /token=abc123/
  );

  const event = events.find((entry) => entry.event === "service.error");
  const log = logs.find((entry) => entry.event === "service.error");
  assert.equal(event.error_message.includes("token=[REDACTED]"), true);
  assert.equal(log.error_message.includes("token=[REDACTED]"), true);
  assert.equal(String(event.error_message).includes("abc123"), false);
  assert.equal(String(log.error_message).includes("abc123"), false);
});

test("create invoice does not expose a wallet expiry longer than requested", async () => {
  const { wallet, openreceive } = await createHarness();
  wallet.expiresAt = 4600;

  const invoice = await openreceive.createInvoice({
    orderId: "order-short-expiry",
    amount: { msats: 200000 },
    memo: "Fruit sticker",
    expiresInSeconds: 600
  });

  assert.equal(invoice.createdAt, 1000);
  assert.equal(invoice.expiresAt, 1600);
});

test("create invoice rejects idempotency key reuse with a different body", async () => {
  const { wallet, openreceive } = await createHarness();

  await openreceive.createInvoice({
    orderId: "order-create-conflict",
    amount: { msats: 200000 },
    memo: "Fruit sticker"
  });

  await assertServiceError(
    () => openreceive.createInvoice({
      orderId: "order-create-conflict",
      amount: { msats: 300000 },
      memo: "Fruit sticker"
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
    source: "primary",
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
    orderId: "order-live-rate",
    amount: {
      fiat: {
        currency: "USD",
        value: "0.05"
      }
    },
    memo: "Fruit sticker"
  });

  assert.equal(invoice.amountMsats, 50000);
  assert.equal(invoice.fiatQuote.amount_msats, 50000);
  assert.equal(invoice.fiatQuote.btc_fiat_price, "100000.00");
  assert.equal(invoice.fiatQuote.source, "primary");
  assert.equal(wallet.makeInvoiceCalls, 1);
  assert.deepEqual(calls, [["USD"]]);
});

test("create invoice accepts BTC and SATS amounts without price providers", async () => {
  const providerCalls = [];
  const provider = {
    source: "primary",
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
    orderId: "order-btc",
    amount: {
      btc: {
        currency: "BTC",
        value: "0.005"
      }
    },
    memo: "BTC amount"
  });
  assert.equal(btcInvoice.amountMsats, 500000000);

  const satsHarness = await createHarness({
    priceProviders: [provider],
    priceCurrencies: ["USD"]
  });
  const satsInvoice = await satsHarness.openreceive.createInvoice({
    orderId: "order-sats",
    amount: {
      sats: "7000"
    },
    memo: "SATS amount"
  });
  assert.equal(satsInvoice.amountMsats, 7000000);
  assert.equal(btcHarness.wallet.makeInvoiceCalls, 1);
  assert.equal(satsHarness.wallet.makeInvoiceCalls, 1);
  assert.deepEqual(providerCalls, []);
});

test("status refresh settles invoice through bounded transaction scan", async () => {
  const { wallet, openreceive } = await createHarness();
  const invoice = await openreceive.createInvoice({
    orderId: "order-2",
    amount: { msats: 200000 },
    memo: "Fruit sticker"
  });

  wallet.transactionState = "settled";
  const status = await openreceive.refreshInvoiceStatus({
    invoiceId: invoice.invoiceId
  });

  assert.equal(status.invoiceId, invoice.invoiceId);
  assert.equal(status.status, "settled");
  assert.equal(status.transactionState, "settled");
  assert.equal(status.workflowState, "settlement_action_completed");
  assert.equal(status.settlementActionState, "completed");
  assert.equal(status.settledAt, 1200);
  assert.equal(status.walletScanPerformed, true);
  assert.equal(status.transactionsChecked, 1);
  assert.equal("checkout" in status, false);
});

test("logger records invoice transitions without secrets", async () => {
  const logs = [];
  const { wallet, openreceive } = await createHarness({
    logger: (entry) => {
      logs.push(entry);
    }
  });
  const invoice = await openreceive.createInvoice({
    orderId: "order-logged",
    amount: { msats: 200000 },
    memo: "Fruit sticker"
  });

  wallet.transactionState = "settled";
  await openreceive.refreshInvoiceStatus({
    invoiceId: invoice.invoiceId
  });

  assert.deepEqual(
    logs.map((entry) => entry.event),
    [
      "invoice.create.requested",
      "invoice.created",
      "invoice.status.requested",
      "invoice.settled",
      "invoice.settlement_action_completed",
      "invoice.status.result"
    ]
  );
  assert.equal(logs[1].invoice_id, invoice.invoiceId);
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
      orderId: "order-wallet-error",
      amount: { msats: 200000 },
      memo: "Fruit sticker"
    }),
    /wallet rejected/
  );

  const errorLog = logs.find((entry) => entry.event === "service.error");
  assert.equal(errorLog.level, "error");
  assert.equal(errorLog.error_message, "wallet rejected [REDACTED_NWC]");
  assert.doesNotMatch(JSON.stringify(logs), /nostr\+walletconnect:\/\//);
  assert.doesNotMatch(JSON.stringify(logs), /a{64}/);
});

test("status refresh can run an idempotent backend settlement action hook after settlement", async () => {
  let onPaidCalls = 0;
  const { wallet, openreceive } = await createHarness({
    clock: () => 1300,
    onPaid: async ({ invoice, orderId, metadata }) => {
      onPaidCalls += 1;
      assert.equal(invoice.transaction_state, "settled");
      assert.equal(orderId, "order-settlement-action");
      assert.deepEqual(metadata, { order_uuid: "order-settlement-action" });
    }
  });
  const invoice = await openreceive.createInvoice({
    orderId: "order-settlement-action",
    amount: { msats: 200000 },
    memo: "Fruit sticker"
  });

  wallet.transactionState = "settled";
  const firstStatus = await openreceive.refreshInvoiceStatus({
    invoiceId: invoice.invoiceId
  });

  assert.equal(firstStatus.workflowState, "settlement_action_completed");
  assert.equal(firstStatus.settlementActionState, "completed");
  assert.equal(firstStatus.settlementActionCompletedAt, 1300);
  assert.equal(onPaidCalls, 1);

  const secondStatus = await openreceive.refreshInvoiceStatus({
    invoiceId: firstStatus.invoiceId
  });

  assert.equal(secondStatus.workflowState, "settlement_action_completed");
  assert.equal(onPaidCalls, 1);
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
    orderId: "order-client-state",
    amount: { msats: 200000 },
    memo: "Fruit sticker"
  });

  wallet.transactionState = "pending";
  const status = await openreceive.refreshInvoiceStatus({
    invoiceId: invoice.invoiceId
  });

  const stored = (await store.get(invoice.invoiceId)).row;
  assert.equal(status.transactionState, "pending");
  assert.equal(status.workflowState, "verifying");
  assert.equal(stored.transaction_state, "pending");
  assert.equal(stored.settlement_action_state, "pending");
  assert.equal(onPaidCalls, 0);
});

test("status refresh rejects unknown invoice ids", async () => {
  const { openreceive } = await createHarness();

  await assertServiceError(
    () => openreceive.refreshInvoiceStatus({
      invoiceId: "or_inv_missing"
    }),
    {
      status: 404,
      code: "NOT_FOUND",
      message: "Invoice not found: or_inv_missing"
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
    source: "primary",
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
      orderId: "order-eur-denied",
      amount: {
        fiat: {
          currency: "EUR",
          value: "0.10"
        }
      },
      memo: "Fruit sticker"
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
    source: "fallback",
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
  assert.equal(quote.source, "fallback");
});

test("create invoice rejects description and description_hash together", async () => {
  const { wallet, openreceive } = await createHarness();

  await assertServiceError(
    () => openreceive.createInvoice({
      orderId: "order-description-conflict",
      amount: { msats: 200000 },
      memo: "Fruit sticker",
      descriptionHash: "a".repeat(64)
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "Create invoice request accepts only one of memo or descriptionHash."
    }
  );
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("create invoice rejects invalid description_hash before wallet call", async () => {
  const { wallet, openreceive } = await createHarness();

  await assertServiceError(
    () => openreceive.createInvoice({
      orderId: "order-description-hash",
      amount: { msats: 200000 },
      descriptionHash: "not-hex"
    }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "descriptionHash must be 64 hex characters."
    }
  );
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("create invoice rejects invalid fiat quote before wallet call", async () => {
  const { wallet, openreceive } = await createHarness();

  await assertServiceError(
    () => openreceive.createInvoice({
      orderId: "order-invalid-fiat",
      amount: {
        fiat: {
          currency: "usd",
          value: "0.10"
        }
      },
      memo: "Fruit sticker"
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
    idempotencyKey: "refresh-1",
    reason: "expired"
  };

  const first = await openreceive.refreshInvoice(oldInvoice.invoice_id, request);
  assert.equal(first.oldInvoiceId, oldInvoice.invoice_id);
  assert.equal(first.reason, "expired");
  assert.equal(first.invoice.refreshedFromInvoiceId, oldInvoice.invoice_id);
  assert.equal(first.invoice.transactionState, "pending");

  const second = await openreceive.refreshInvoice(oldInvoice.invoice_id, request);
  assert.equal(second.newInvoiceId, first.newInvoiceId);
  assert.equal(wallet.makeInvoiceCalls, 1);

  const storedOld = (await store.get(oldInvoice.invoice_id)).row;
  const storedNew = (await store.get(first.newInvoiceId)).row;
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
    idempotencyKey: "refresh-conflict",
    reason: "expired"
  });

  await assertServiceError(
    () => openreceive.refreshInvoice(oldInvoice.invoice_id, {
      idempotencyKey: "refresh-conflict",
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
      idempotencyKey: "refresh-settled",
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

test("refresh invoice requires idempotencyKey as service input", async () => {
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
      message: "idempotencyKey is required."
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
      orderId: "order-denied",
      amount: { msats: 200000 }
    }
  });
  assert.equal(denied.status, 403);
  assert.equal(wallet.makeInvoiceCalls, 0);

  const allowed = await guardedCreate({
    user: {
      id: "alice"
    },
    body: {
      orderId: "order-allowed",
      amount: { msats: 200000 }
    }
  });
  assert.equal(allowed.status, 201);
  assert.equal(wallet.makeInvoiceCalls, 1);

  const read = await openreceive.getInvoice(allowed.body.invoiceId);
  assert.equal(read.invoiceId, allowed.body.invoiceId);
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
      namespace: "demo_hello_fruit"
    };

    await assert.rejects(
      () => createOpenReceive(options),
      (error) => {
        assert.equal(error instanceof OpenReceiveConfigError, true);
        assert.equal(error.code, "UNSAFE_MEMORY_STORE");
        return true;
      }
    );
    await assert.rejects(
      () => createOpenReceive({
        ...options,
        store: undefined,
        storeUri: "memory:"
      }),
      (error) => {
        assert.equal(error instanceof OpenReceiveConfigError, true);
        assert.equal(error.code, "UNSAFE_MEMORY_STORE");
        return true;
      }
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
