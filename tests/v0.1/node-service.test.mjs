import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryInvoiceKvStore, StaticPriceProvider } from "../../packages/js/core/src/index.ts";
import {
  OpenReceiveConfigError,
  OpenReceiveServiceError,
  createOpenReceive,
} from "../../packages/js/node/src/index.ts";

class FakeWallet {
  makeInvoiceCalls = 0;
  listTransactionsCalls = 0;
  makeInvoiceError = undefined;
  invoices = [];

  constructor(now) {
    this.now = now;
  }

  async preflight() {
    return {
      walletPubkey: "f".repeat(64),
      relays: ["wss://relay.example.com"],
      methods: ["make_invoice", "list_transactions"],
      encryption: "nip04",
      spendCapabilityAdvertised: false,
      receiveCheckoutReady: true,
      warnings: [],
    };
  }

  async makeInvoice(request) {
    this.makeInvoiceCalls += 1;
    if (this.makeInvoiceError !== undefined) {
      throw this.makeInvoiceError;
    }
    const amountMsats =
      typeof request.amount_msats === "bigint"
        ? request.amount_msats
        : BigInt(request.amount_msats ?? request.amount);
    const index = this.makeInvoiceCalls;
    const createdAt = this.now();
    const invoice = {
      invoice: `lnbc-demo-${index}`,
      payment_hash: index.toString(16).padStart(64, "0"),
      amount_msats: amountMsats,
      created_at: createdAt,
      expires_at: createdAt + (request.expiry ?? 600),
      state: "pending",
    };
    this.invoices.push(invoice);
    return invoice;
  }

  async listTransactions(request) {
    this.listTransactionsCalls += 1;
    if (request.type === "outgoing") return { transactions: [] };
    const from = request.from ?? 0;
    const until = request.until ?? Number.MAX_SAFE_INTEGER;
    const offset = request.offset ?? 0;
    const limit = request.limit ?? Number.MAX_SAFE_INTEGER;
    return {
      transactions: this.invoices
        .filter((invoice) => invoice.created_at >= from && invoice.created_at <= until)
        .slice(offset, offset + limit)
        .map((invoice) => ({
          type: "incoming",
          invoice: invoice.invoice,
          payment_hash: invoice.payment_hash,
          amount_msats: invoice.amount_msats,
          state: invoice.state,
          settled_at: invoice.state === "settled" ? invoice.settled_at : undefined,
          preimage: invoice.state === "settled" ? "1".repeat(64) : undefined,
        })),
    };
  }

  settlePaymentHash(paymentHash, settledAt) {
    const invoice = this.invoices.find((item) => item.payment_hash === paymentHash);
    if (invoice === undefined) throw new Error(`unknown payment hash ${paymentHash}`);
    invoice.state = "settled";
    invoice.settled_at = settledAt;
  }
}

async function createHarness(overrides = {}) {
  let now = overrides.now ?? 1000;
  const wallet = overrides.client ?? new FakeWallet(() => now);
  const store = overrides.store ?? new InMemoryInvoiceKvStore();
  const openreceive = await createOpenReceive({
    client: wallet,
    store,
    namespace: "demo_hello_fruit",
    clock: () => now,
    priceProviders: [new StaticPriceProvider()],
    ...overrides,
  });

  return {
    wallet,
    store,
    openreceive,
    setNow(nextNow) {
      now = nextNow;
    },
  };
}

test("createCheckout mints once and replays the live invoice for the same amount", async () => {
  const { wallet, openreceive } = await createHarness();
  const request = {
    orderId: "order-1",
    amount: { msats: 200000 },
    memo: "Fruit sticker",
    expiresInSeconds: 600,
  };

  const first = await openreceive.createCheckout(request);
  assert.equal(first.checkoutId.startsWith("or_chk_"), true);
  assert.equal(first.orderId, "order-1");
  assert.equal(first.status, "open");
  assert.equal(first.active.bolt11, "lnbc-demo-1");
  assert.equal(first.amountMsats, 200000);
  assert.equal(first.invoices.length, 1);

  const second = await openreceive.createCheckout(request);
  assert.equal(second.checkoutId, first.checkoutId);
  assert.equal(second.active.invoiceId, first.active.invoiceId);
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("createCheckout creates a new checkout and supersedes the open checkout for a different amount", async () => {
  const { wallet, openreceive } = await createHarness();

  const first = await openreceive.createCheckout({
    orderId: "order-conflict",
    amount: { msats: 200000 },
  });

  const second = await openreceive.createCheckout({
    orderId: "order-conflict",
    amount: { msats: 300000 },
  });
  assert.notEqual(second.checkoutId, first.checkoutId);
  assert.equal(second.status, "open");
  assert.equal(second.amountMsats, 300000);
  assert.equal(wallet.makeInvoiceCalls, 2);

  const order = await openreceive.getOrder({ orderId: "order-conflict" });
  assert.equal(order.status, "pending");
  assert.equal(order.activeCheckout.checkoutId, second.checkoutId);
  assert.equal(order.checkouts.length, 2);
  assert.equal(
    order.checkouts.find((checkout) => checkout.checkoutId === first.checkoutId).status,
    "superseded",
  );
});

test("createCheckout renews after expiry within the same checkout", async () => {
  const { wallet, store, openreceive, setNow } = await createHarness();
  const first = await openreceive.createCheckout({
    orderId: "order-renew",
    amount: { sats: "200" },
    memo: "Fruit sticker",
    expiresInSeconds: 600,
  });

  setNow(1700);
  const renewed = await openreceive.createCheckout({
    orderId: "order-renew",
    amount: { sats: "200" },
    memo: "Fruit sticker",
    expiresInSeconds: 600,
  });
  const replayed = await openreceive.createCheckout({
    orderId: "order-renew",
    amount: { sats: "200" },
    memo: "Fruit sticker",
    expiresInSeconds: 600,
  });

  assert.equal(renewed.checkoutId, first.checkoutId);
  assert.notEqual(renewed.active.invoiceId, first.active.invoiceId);
  assert.equal(replayed.active.invoiceId, renewed.active.invoiceId);
  assert.equal(renewed.invoices.length, 2);
  assert.equal(renewed.invoices[0].refreshedFromInvoiceId, first.active.invoiceId);
  assert.equal(wallet.makeInvoiceCalls, 2);

  const storedRenewal = (await store.get(renewed.active.invoiceId)).row;
  assert.equal(storedRenewal.operation, "invoice.renew");
  assert.equal(storedRenewal.metadata.order_id, "order-renew");
  assert.equal(storedRenewal.metadata.checkout_id, first.checkoutId);
  assert.deepEqual(storedRenewal.metadata.amount_spec, { sats: "200" });
  assert.equal(storedRenewal.metadata.expires_in_seconds, 600);
});

test("renewal re-quotes fiat orders and reuses fixed bitcoin amounts", async () => {
  let btcUsd = "100000.00";
  const provider = {
    source: "primary",
    async getBtcFiatRates(currencies) {
      assert.deepEqual(currencies, ["USD"]);
      return {
        bitcoin: {
          usd: btcUsd,
        },
      };
    },
  };
  const fiatHarness = await createHarness({
    priceProviders: [provider],
    priceCurrencies: ["USD"],
  });
  const fiatFirst = await fiatHarness.openreceive.createCheckout({
    orderId: "order-fiat-renew",
    amount: {
      fiat: {
        currency: "USD",
        value: "0.05",
      },
    },
    expiresInSeconds: 600,
  });
  assert.equal(fiatFirst.amountMsats, 50000);

  btcUsd = "50000.00";
  fiatHarness.setNow(1700);
  const fiatRenewed = await fiatHarness.openreceive.createCheckout({
    orderId: "order-fiat-renew",
    amount: {
      fiat: {
        currency: "USD",
        value: "0.05",
      },
    },
    expiresInSeconds: 600,
  });
  assert.equal(fiatRenewed.amountMsats, 100000);

  const fixedHarness = await createHarness();
  const fixedFirst = await fixedHarness.openreceive.createCheckout({
    orderId: "order-fixed-renew",
    amount: { sats: 7000 },
    expiresInSeconds: 600,
  });
  fixedHarness.setNow(1700);
  const fixedRenewed = await fixedHarness.openreceive.createCheckout({
    orderId: "order-fixed-renew",
    amount: { sats: 7000 },
    expiresInSeconds: 600,
  });
  assert.equal(fixedRenewed.amountMsats, fixedFirst.amountMsats);
});

test("getOrder settles a late payment on any invoice in any checkout history", async () => {
  let onPaidCalls = 0;
  const { wallet, openreceive } = await createHarness({
    onPaid: async ({ invoice, orderId }) => {
      onPaidCalls += 1;
      assert.equal(orderId, "order-late-paid");
      assert.equal(invoice.transaction_state, "settled");
    },
  });
  const first = await openreceive.createCheckout({
    orderId: "order-late-paid",
    amount: { msats: 200000 },
    expiresInSeconds: 600,
  });
  const superseding = await openreceive.createCheckout({
    orderId: "order-late-paid",
    amount: { msats: 300000 },
    expiresInSeconds: 600,
  });

  wallet.settlePaymentHash(first.active.paymentHash, 1200);
  const order = await openreceive.getOrder({
    orderId: "order-late-paid",
  });

  assert.equal(order.paid, true);
  assert.equal(order.status, "paid");
  assert.equal(order.paidAt, 1200);
  assert.equal(order.paidCheckout.checkoutId, first.checkoutId);
  assert.equal(order.paidCheckout.amountMsats, 200000);
  assert.equal(order.checkouts.length, 2);
  assert.equal(
    order.checkouts.some((checkout) => checkout.checkoutId === superseding.checkoutId),
    true,
  );
  assert.equal(order.walletScanPerformed, true);
  assert.equal(order.transactionsChecked, 2);
  assert.equal(onPaidCalls, 1);

  const second = await openreceive.getOrder({
    orderId: "order-late-paid",
  });
  assert.equal(second.paid, true);
  assert.equal(onPaidCalls, 1);
});

test("createCheckout is a no-op for paid orders", async () => {
  const { wallet, openreceive } = await createHarness();
  const created = await openreceive.createCheckout({
    orderId: "order-paid-noop",
    amount: { msats: 200000 },
  });
  wallet.settlePaymentHash(created.active.paymentHash, 1200);
  await openreceive.getOrder({ orderId: "order-paid-noop" });

  const before = wallet.makeInvoiceCalls;
  const paid = await openreceive.createCheckout({
    orderId: "order-paid-noop",
    amount: { msats: 300000 },
  });
  assert.equal(paid.checkoutId, created.checkoutId);
  assert.equal(paid.status, "paid");
  assert.equal(wallet.makeInvoiceCalls, before);
});

test("getOrder on an unknown order returns a service 404", async () => {
  const { openreceive } = await createHarness();

  await assertServiceError(() => openreceive.getOrder({ orderId: "missing-order" }), {
    status: 404,
    code: "NOT_FOUND",
    message: "No order found for the given orderId.",
  });
});

test("service errors surface as OpenReceiveServiceError with status and body", async () => {
  const { wallet, openreceive } = await createHarness();

  await assertServiceError(
    () =>
      openreceive.createCheckout({
        orderId: "order-invalid-fiat",
        amount: {
          fiat: {
            currency: "usd",
            value: "0.10",
          },
        },
      }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "fiat.currency must be an ISO 4217 uppercase code",
    },
  );
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("diagnostic events and logger entries are sanitized and non-blocking", async () => {
  const events = [];
  const logs = [];
  const wallet = new FakeWallet(() => 1000);
  wallet.makeInvoiceError = new Error(
    "wallet failed with https://example.test/path?token=abc123&ok=1",
  );
  const { openreceive } = await createHarness({
    client: wallet,
    onEvent: (event) => {
      events.push(event);
      if (event.event === "service.error") throw new Error("event sink is down");
    },
    logger: (entry) => logs.push(entry),
  });

  await assert.rejects(
    () =>
      openreceive.createCheckout({
        orderId: "order-diagnostics",
        amount: { msats: 200000 },
        memo: "Fruit sticker",
      }),
    /token=abc123/,
  );

  const event = events.find((entry) => entry.event === "service.error");
  const log = logs.find((entry) => entry.event === "service.error");
  assert.equal(event.error_message.includes("token=[REDACTED]"), true);
  assert.equal(log.error_message.includes("token=[REDACTED]"), true);
  assert.equal(String(event.error_message).includes("abc123"), false);
  assert.equal(String(log.error_message).includes("abc123"), false);
});

test("read-only rate helpers expose static rates and quotes", async () => {
  const { openreceive } = await createHarness();

  const rates = await openreceive.listRates();
  assert.equal(rates.bitcoin.usd, "50000.00");

  const quote = await openreceive.quoteRates({
    fiat: {
      currency: "USD",
      value: "0.10",
    },
  });
  assert.equal(quote.amount_msats, 200000);
  assert.equal(quote.source, "static_mock");
});

test("createOpenReceive defaults to live cached price data and fails unhealthy boot", async () => {
  const store = new InMemoryInvoiceKvStore();

  await assert.rejects(
    () =>
      createOpenReceive({
        client: new FakeWallet(() => 1000),
        store,
        namespace: "demo_hello_fruit",
        priceFetch: async () => ({
          ok: false,
          status: 503,
          text: async () => "{}",
        }),
      }),
    (error) => {
      assert.equal(error instanceof OpenReceiveConfigError, true);
      assert.equal(error.code, "UNHEALTHY_PRICE_DATA");
      return true;
    },
  );
});

test("createOpenReceive refuses in-memory invoice storage in production mode", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalOpenReceiveMode = process.env.OPENRECEIVE_MODE;
  process.env.NODE_ENV = "production";
  delete process.env.OPENRECEIVE_MODE;

  try {
    await assert.rejects(
      () =>
        createOpenReceive({
          client: new FakeWallet(() => 1000),
          store: new InMemoryInvoiceKvStore(),
          namespace: "demo_hello_fruit",
        }),
      (error) => {
        assert.equal(error instanceof OpenReceiveConfigError, true);
        assert.equal(error.code, "UNSAFE_MEMORY_STORE");
        return true;
      },
    );
  } finally {
    restoreEnvVar("NODE_ENV", originalNodeEnv);
    restoreEnvVar("OPENRECEIVE_MODE", originalOpenReceiveMode);
  }
});

async function assertServiceError(action, expected) {
  await assert.rejects(action, (error) => {
    assert.equal(error instanceof OpenReceiveServiceError, true);
    assert.equal(error.status, expected.status);
    assert.equal(error.body.code, expected.code);
    assert.equal(error.body.message, expected.message);
    return true;
  });
}

function restoreEnvVar(name, value) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
