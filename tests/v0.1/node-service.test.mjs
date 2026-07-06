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
        .sort((left, right) =>
          left.created_at === right.created_at
            ? right.payment_hash.localeCompare(left.payment_hash)
            : right.created_at - left.created_at,
        )
        .slice(offset, offset + limit)
        .map((invoice) => ({
          type: "incoming",
          invoice: invoice.invoice,
          payment_hash: invoice.payment_hash,
          amount_msats: invoice.amount_msats,
          state: invoice.state,
          created_at: invoice.created_at,
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

class FakeSwapProvider {
  name = "fixedfloat";
  createCalls = 0;
  quoteCalls = 0;
  statusCalls = 0;
  refundCalls = [];
  orders = new Map();
  nextState = undefined;

  constructor(supported = ["USDT_TRON", "SOL_SOL", "ETH_ETH"]) {
    this.supported = new Set(supported);
  }

  async supportedPayInAssets() {
    return new Set(this.supported);
  }

  async quote({ payInAsset }) {
    this.quoteCalls += 1;
    return {
      pay_amount: payInAsset === "ETH_ETH" ? "0.0008" : "1.05",
      pay_asset: payInAsset,
      min_ok: true,
      max_ok: true,
      provider: this.name,
    };
  }

  async createSwap({ payInAsset }) {
    this.createCalls += 1;
    const order = {
      provider: this.name,
      provider_order_id: `ff-order-${this.createCalls}`,
      provider_token: `ff-token-${this.createCalls}`,
      pay_in_asset: payInAsset,
      deposit_address:
        payInAsset === "SOL_SOL"
          ? "So11111111111111111111111111111111111111112"
          : payInAsset === "ETH_ETH"
            ? "0x1111111111111111111111111111111111111111"
            : "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
      deposit_amount: payInAsset === "ETH_ETH" ? "0.0008" : "1.05",
      expires_at: 1600,
      state: "awaiting_deposit",
    };
    this.orders.set(order.provider_order_id, order);
    return order;
  }

  async getStatus(order) {
    this.statusCalls += 1;
    const stored = this.orders.get(order.provider_order_id) ?? order;
    const state = this.nextState ?? stored.state;
    const updated = {
      ...stored,
      state,
      ...(state === "completed" ? { payout_tx_id: "ln-payout-1" } : {}),
      ...(state === "refund_required" ? { deposit_tx_id: "deposit-tx-1" } : {}),
    };
    this.orders.set(order.provider_order_id, updated);
    return updated;
  }

  async requestRefund(order, refundAddress) {
    this.refundCalls.push({
      provider_order_id: order.provider_order_id,
      refundAddress,
    });
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
    amount: { btc: { currency: "BTC", value: "0.000002" } },
    memo: "Fruit sticker",
  };

  const first = await openreceive.createCheckout(request);
  assert.equal(first.checkout_id.startsWith("or_chk_"), true);
  assert.equal(first.order_id, "order-1");
  assert.equal(first.status, "open");
  assert.equal(first.active.invoice, "lnbc-demo-1");
  assert.equal(first.amount_msats, 200000);
  assert.equal(first.invoices.length, 1);

  const second = await openreceive.createCheckout(request);
  assert.equal(second.checkout_id, first.checkout_id);
  assert.equal(second.active.invoice_id, first.active.invoice_id);
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("swapOptions are disabled unless a swap provider is configured", async () => {
  const { openreceive } = await createHarness();
  await openreceive.createCheckout({
    orderId: "order-swap-disabled",
    amount: { btc: { currency: "SATS", value: "200" } },
  });

  assert.deepEqual(await openreceive.swapOptions({ orderId: "order-swap-disabled" }), {
    enabled: false,
    options: [],
  });
});

test("startSwap creates an idempotent shadow invoice without replacing active Lightning", async () => {
  const swapProvider = new FakeSwapProvider();
  const { wallet, store, openreceive } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  const checkout = await openreceive.createCheckout({
    orderId: "order-swap-start",
    amount: { btc: { currency: "SATS", value: "200" } },
    memo: "Fruit sticker",
  });

  const options = await openreceive.swapOptions({ orderId: "order-swap-start" });
  assert.equal(options.enabled, true);
  assert.equal(options.options.some((option) => option.pay_in_asset === "USDT_TRON"), true);

  const first = await openreceive.startSwap({
    orderId: "order-swap-start",
    payInAsset: "USDT_TRON",
  });
  const second = await openreceive.startSwap({
    orderId: "order-swap-start",
    payInAsset: "USDT_TRON",
  });

  assert.equal(first.invoice_id, second.invoice_id);
  assert.equal(first.rail, "swap");
  assert.equal(first.amount_msats, checkout.amount_msats);
  assert.equal(first.swap.provider, "fixedfloat");
  assert.equal(first.swap.pay_in_asset, "USDT_TRON");
  assert.equal(first.swap.deposit_address, "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
  assert.equal("provider_token" in first.swap, false);
  assert.equal(wallet.makeInvoiceCalls, 2);
  assert.equal(swapProvider.createCalls, 1);

  const order = await openreceive.getOrder({ orderId: "order-swap-start" });
  assert.equal(order.active_checkout.active.invoice_id, checkout.active.invoice_id);
  assert.equal(order.active_checkout.invoices.length, 2);
  assert.equal(order.active_checkout.invoices.some((invoice) => invoice.rail === "swap"), true);

  const stored = await store.get(first.invoice_id);
  assert.equal(stored.row.metadata.swap.provider_token, "ff-token-1");
});

test("settling a shadow swap invoice pays the checkout", async () => {
  const swapProvider = new FakeSwapProvider();
  const { wallet, openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-settle",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  const swapInvoice = await openreceive.startSwap({
    orderId: "order-swap-settle",
    payInAsset: "SOL_SOL",
  });

  wallet.settlePaymentHash(swapInvoice.payment_hash, 1200);
  setNow(1015);
  const order = await openreceive.getOrder({ orderId: "order-swap-settle" });

  assert.equal(order.status, "paid");
  assert.equal(order.paid_checkout.invoices.some((invoice) => invoice.invoice_id === swapInvoice.invoice_id), true);
  assert.equal(order.paid_at, 1200);
});

test("a superseded checkout is still paid when its shadow invoice settles later", async () => {
  const swapProvider = new FakeSwapProvider();
  const { wallet, openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-supersede",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  const swapInvoice = await openreceive.startSwap({
    orderId: "order-swap-supersede",
    payInAsset: "USDT_TRON",
  });
  const replacement = await openreceive.createCheckout({
    orderId: "order-swap-supersede",
    amount: { btc: { currency: "SATS", value: "300" } },
  });

  wallet.settlePaymentHash(swapInvoice.payment_hash, 1210);
  setNow(1015);
  const order = await openreceive.getOrder({ orderId: "order-swap-supersede" });

  assert.equal(order.status, "paid");
  assert.equal(order.paid_checkout.checkout_id !== replacement.checkout_id, true);
  assert.equal(order.paid_checkout.status, "paid");
  assert.equal(order.paid_checkout.invoices.some((invoice) => invoice.invoice_id === swapInvoice.invoice_id), true);
});

test("refundSwap requests a provider refund only for refund-required swaps", async () => {
  const swapProvider = new FakeSwapProvider();
  const { openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-refund",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  await openreceive.startSwap({
    orderId: "order-swap-refund",
    payInAsset: "ETH_ETH",
  });

  swapProvider.nextState = "refund_required";
  setNow(1015);
  const refreshed = await openreceive.getOrder({ orderId: "order-swap-refund" });
  const refundRequired = refreshed.active_checkout.invoices.find((invoice) => invoice.rail === "swap");
  assert.equal(refundRequired.swap.provider_state, "refund_required");
  assert.equal(refundRequired.swap.deposit_tx_id, "deposit-tx-1");

  const refunded = await openreceive.refundSwap({
    orderId: "order-swap-refund",
    payInAsset: "ETH_ETH",
    refundAddress: "0x2222222222222222222222222222222222222222",
  });

  assert.equal(refunded.swap.provider_state, "refund_pending");
  assert.equal(refunded.swap.refund_address, "0x2222222222222222222222222222222222222222");
  assert.deepEqual(swapProvider.refundCalls, [
    {
      provider_order_id: "ff-order-1",
      refundAddress: "0x2222222222222222222222222222222222222222",
    },
  ]);
});

test("createCheckout creates a new checkout and supersedes the open checkout for a different amount", async () => {
  const { wallet, openreceive } = await createHarness();

  const first = await openreceive.createCheckout({
    orderId: "order-conflict",
    amount: { btc: { currency: "BTC", value: "0.000002" } },
  });

  const second = await openreceive.createCheckout({
    orderId: "order-conflict",
    amount: { btc: { currency: "BTC", value: "0.000003" } },
  });
  assert.notEqual(second.checkout_id, first.checkout_id);
  assert.equal(second.status, "open");
  assert.equal(second.amount_msats, 300000);
  assert.equal(wallet.makeInvoiceCalls, 2);

  const order = await openreceive.getOrder({ orderId: "order-conflict" });
  assert.equal(order.status, "pending");
  assert.equal(order.active_checkout.checkout_id, second.checkout_id);
  assert.equal(order.display_checkout.checkout_id, second.checkout_id);
  assert.equal(order.checkouts.length, 2);
  assert.equal(
    order.checkouts.find((checkout) => checkout.checkout_id === first.checkout_id).status,
    "superseded",
  );
});

test("createCheckout creates a new checkout after expiry when called again", async () => {
  const { wallet, store, openreceive, setNow } = await createHarness();
  const first = await openreceive.createCheckout({
    orderId: "order-retry",
    amount: { btc: { currency: "SATS", value: "200" } },
    memo: "Fruit sticker",
  });

  setNow(1700);
  const expiredOrder = await openreceive.getOrder({ orderId: "order-retry" });
  assert.equal(expiredOrder.status, "expired");
  assert.equal(expiredOrder.active_checkout, undefined);
  assert.equal(expiredOrder.display_checkout.checkout_id, first.checkout_id);
  assert.equal(expiredOrder.checkouts[0].checkout_id, first.checkout_id);
  assert.equal(expiredOrder.checkouts[0].status, "expired");
  assert.equal(wallet.makeInvoiceCalls, 1);

  const retried = await openreceive.createCheckout({
    orderId: "order-retry",
    amount: { btc: { currency: "SATS", value: "200" } },
    memo: "Fruit sticker",
  });
  const replayed = await openreceive.createCheckout({
    orderId: "order-retry",
    amount: { btc: { currency: "SATS", value: "200" } },
    memo: "Fruit sticker",
  });

  assert.notEqual(retried.checkout_id, first.checkout_id);
  assert.notEqual(retried.active.invoice_id, first.active.invoice_id);
  assert.equal(replayed.checkout_id, retried.checkout_id);
  assert.equal(replayed.active.invoice_id, retried.active.invoice_id);
  assert.equal(retried.invoices.length, 1);
  assert.equal(retried.invoices[0].refreshed_from_invoice_id, undefined);
  assert.equal(wallet.makeInvoiceCalls, 2);

  const storedRetry = (await store.get(retried.active.invoice_id)).row;
  assert.equal(storedRetry.operation, "invoice.create");
  assert.equal(storedRetry.metadata.order_id, "order-retry");
  assert.equal(storedRetry.metadata.checkout_id, retried.checkout_id);
  assert.deepEqual(storedRetry.metadata.amount_spec, {
    btc: { currency: "SATS", value: "200" },
  });
  assert.equal(storedRetry.metadata.expires_in_seconds, undefined);
});

test("expiry retry re-quotes fiat orders and reuses fixed bitcoin amounts", async () => {
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
    orderId: "order-fiat-retry",
    amount: {
      fiat: {
        currency: "USD",
        value: "0.05",
      },
    },
  });
  assert.equal(fiatFirst.amount_msats, 50000);

  btcUsd = "50000.00";
  fiatHarness.setNow(1700);
  const fiatRenewed = await fiatHarness.openreceive.createCheckout({
    orderId: "order-fiat-retry",
    amount: {
      fiat: {
        currency: "USD",
        value: "0.05",
      },
    },
  });
  assert.equal(fiatRenewed.amount_msats, 100000);
  assert.notEqual(fiatRenewed.checkout_id, fiatFirst.checkout_id);

  const fixedHarness = await createHarness();
  const fixedFirst = await fixedHarness.openreceive.createCheckout({
    orderId: "order-fixed-retry",
    amount: { btc: { currency: "SATS", value: "7000" } },
  });
  fixedHarness.setNow(1700);
  const fixedRenewed = await fixedHarness.openreceive.createCheckout({
    orderId: "order-fixed-retry",
    amount: { btc: { currency: "SATS", value: "7000" } },
  });
  assert.equal(fixedRenewed.amount_msats, fixedFirst.amount_msats);
  assert.notEqual(fixedRenewed.checkout_id, fixedFirst.checkout_id);
});

test("getOrder settles a late payment on any invoice in any checkout history", async () => {
  let onPaidCalls = 0;
  const { wallet, openreceive, setNow } = await createHarness({
    onPaid: async ({
      invoice,
      orderId,
      checkoutId,
      invoiceId,
      paymentHash,
      amountMsats,
      metadata,
    }) => {
      onPaidCalls += 1;
      assert.equal(orderId, "order-late-paid");
      assert.equal(checkoutId, first.checkout_id);
      assert.equal(invoiceId, first.active.invoice_id);
      assert.equal(paymentHash, first.active.payment_hash);
      assert.equal(amountMsats, 200000);
      assert.equal(metadata.cart_id, "cart-123");
      assert.equal(metadata.checkout_id, first.checkout_id);
      assert.equal(invoice.transaction_state, "settled");
    },
  });
  const first = await openreceive.createCheckout({
    orderId: "order-late-paid",
    amount: { btc: { currency: "BTC", value: "0.000002" } },
    metadata: {
      cart_id: "cart-123",
      checkout_id: "must-not-overwrite",
    },
  });
  const superseding = await openreceive.createCheckout({
    orderId: "order-late-paid",
    amount: { btc: { currency: "BTC", value: "0.000003" } },
  });

  wallet.settlePaymentHash(first.active.payment_hash, 1200);
  setNow(1002);
  const order = await openreceive.getOrder({
    orderId: "order-late-paid",
  });

  assert.equal(order.paid, true);
  assert.equal(order.status, "paid");
  assert.equal(order.paid_at, 1200);
  assert.equal(order.paid_checkout.checkout_id, first.checkout_id);
  assert.equal(order.display_checkout.checkout_id, first.checkout_id);
  assert.equal(order.paid_checkout.amount_msats, 200000);
  assert.equal(order.checkouts.length, 2);
  assert.equal(
    order.checkouts.some((checkout) => checkout.checkout_id === superseding.checkout_id),
    true,
  );
  assert.equal(order.wallet_scan_performed, true);
  assert.equal(order.transactions_checked, 2);
  assert.equal(onPaidCalls, 1);

  setNow(1004);
  const second = await openreceive.getOrder({
    orderId: "order-late-paid",
  });
  assert.equal(second.paid, true);
  assert.equal(onPaidCalls, 1);
});

test("getOrder on one order settles another order's closed-browser payment", async () => {
  const paid = [];
  const background = [];
  const { wallet, store, openreceive, setNow } = await createHarness({
    waitUntil: (promise) => {
      background.push(promise);
    },
    onPaid: async (input) => {
      paid.push(input);
    },
  });

  const orderA = await openreceive.createCheckout({
    orderId: "order-closed-a",
    amount: { btc: { currency: "BTC", value: "0.000002" } },
  });
  await Promise.all(background.splice(0));
  setNow(1003);
  const orderB = await openreceive.createCheckout({
    orderId: "order-active-b",
    amount: { btc: { currency: "BTC", value: "0.000003" } },
  });
  await Promise.all(background.splice(0));

  wallet.settlePaymentHash(orderA.active.payment_hash, 1200);
  setNow(1005);
  const bStatus = await openreceive.getOrder({ orderId: "order-active-b" });
  const aStored = await store.get(orderA.active.invoice_id);

  assert.equal(bStatus.order_id, "order-active-b");
  assert.equal(bStatus.paid, false);
  assert.equal(bStatus.active_checkout.checkout_id, orderB.checkout_id);
  assert.equal(bStatus.wallet_scan_performed, true);
  assert.equal(aStored.row.transaction_state, "settled");
  assert.equal(aStored.row.workflow_state, "settlement_action_completed");
  assert.equal(aStored.row.settled_at, 1200);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].orderId, "order-closed-a");
  assert.equal(paid[0].checkoutId, orderA.checkout_id);
  assert.equal(paid[0].invoiceId, orderA.active.invoice_id);
});

test("createCheckout is a no-op for paid orders", async () => {
  const { wallet, openreceive, setNow } = await createHarness();
  const created = await openreceive.createCheckout({
    orderId: "order-paid-noop",
    amount: { btc: { currency: "BTC", value: "0.000002" } },
  });
  wallet.settlePaymentHash(created.active.payment_hash, 1200);
  setNow(1002);
  await openreceive.getOrder({ orderId: "order-paid-noop" });

  const before = wallet.makeInvoiceCalls;
  const paid = await openreceive.createCheckout({
    orderId: "order-paid-noop",
    amount: { btc: { currency: "BTC", value: "0.000003" } },
  });
  assert.equal(paid.checkout_id, created.checkout_id);
  assert.equal(paid.status, "paid");
  assert.equal(wallet.makeInvoiceCalls, before);
});

test("getOrder on an unknown order returns a service 404", async () => {
  const { openreceive } = await createHarness();

  await assertServiceError(() => openreceive.getOrder({ orderId: "missing-order" }), {
    status: 404,
    code: "NOT_FOUND",
    message: "No order found for the given order_id.",
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

test("createCheckout accepts usd and sats amount shortcuts", async () => {
  const { wallet, openreceive } = await createHarness();

  const usd = await openreceive.getOrCreateCheckout({
    orderId: "order-shortcut-usd",
    usd: "0.10",
  });
  const sats = await openreceive.createCheckout({
    orderId: "order-shortcut-sats",
    sats: 200,
  });

  assert.equal(usd.amount_msats, 200000);
  assert.deepEqual(usd.fiat, { currency: "USD", value: "0.10" });
  assert.equal(sats.amount_msats, 200000);
  assert.deepEqual(sats.invoices[0].fiat_quote, null);
  assert.equal(wallet.makeInvoiceCalls, 2);
});

test("createCheckout rejects invalid explicit amount shapes", async () => {
  const { wallet, openreceive } = await createHarness();

  for (const amount of [{ sats: "200" }, { msats: "200000" }]) {
    await assertServiceError(
      () =>
        openreceive.createCheckout({
          orderId: `order-invalid-${Object.keys(amount)[0]}`,
          amount,
        }),
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: "Create checkout request requires exactly one of amount.btc or amount.fiat.",
      },
    );
  }
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
        amount: { btc: { currency: "BTC", value: "0.000002" } },
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

  assert.equal(openreceive.namespace, "demo_hello_fruit");
  assert.deepEqual(openreceive.priceCurrencies, ["USD"]);

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

test("createOpenReceive exposes normalized price currency configuration", async () => {
  const previous = process.env.OPENRECEIVE_PRICE_CURRENCIES;
  process.env.OPENRECEIVE_PRICE_CURRENCIES = "eur, usd, EUR";
  try {
    const openreceive = await createOpenReceive({
      client: new FakeWallet(() => 1000),
      store: new InMemoryInvoiceKvStore(),
      namespace: "currency_config",
      clock: () => 1000,
      priceProviders: [new StaticPriceProvider()],
    });

    assert.equal(openreceive.namespace, "currency_config");
    assert.deepEqual(openreceive.priceCurrencies, ["EUR", "USD"]);
  } finally {
    if (previous === undefined) {
      delete process.env.OPENRECEIVE_PRICE_CURRENCIES;
    } else {
      process.env.OPENRECEIVE_PRICE_CURRENCIES = previous;
    }
  }
});

test("createOpenReceive fetches default live price data only when rates are needed", async () => {
  const store = new InMemoryInvoiceKvStore();
  let fetchCalls = 0;

  const openreceive = await createOpenReceive({
    client: new FakeWallet(() => 1000),
    store,
    namespace: "demo_hello_fruit",
    clock: () => 1000,
    priceFetch: async () => {
      fetchCalls += 1;
      return {
        ok: false,
        status: 503,
        text: async () => "{}",
      };
    },
  });

  assert.equal(fetchCalls, 0);

  const btcCheckout = await openreceive.createCheckout({
    orderId: "order-live-btc",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  assert.equal(btcCheckout.amount_msats, 200000);
  assert.equal(fetchCalls, 0);

  await assertServiceError(
    () =>
      openreceive.createCheckout({
        orderId: "order-live-fiat",
        amount: {
          fiat: {
            currency: "USD",
            value: "0.10",
          },
        },
      }),
    {
      status: 503,
      code: "INTERNAL",
      message: "Unable to fetch BTC fiat exchange rate.",
    },
  );
  assert.equal(fetchCalls, 2);

  await assertServiceError(
    () =>
      openreceive.createCheckout({
        orderId: "order-live-fiat-retry",
        amount: {
          fiat: {
            currency: "USD",
            value: "0.10",
          },
        },
      }),
    {
      status: 503,
      code: "INTERNAL",
      message: "Unable to fetch BTC fiat exchange rate.",
    },
  );
  assert.equal(fetchCalls, 2);
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
