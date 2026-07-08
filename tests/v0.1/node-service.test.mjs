import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryInvoiceKvStore, StaticPriceProvider } from "../../packages/js/core/src/index.ts";
import {
  createOpenReceive,
  OpenReceiveConfigError,
  OpenReceiveServiceError,
} from "../../packages/js/node/src/index.ts";
import { fixedFloatProvider } from "../../packages/js/node/src/swap/fixedfloat.ts";

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
  catalogCalls = 0;
  statusCalls = 0;
  refundCalls = [];
  quoteInputs = [];
  createSwapInputs = [];
  orders = new Map();
  nextState = undefined;
  createSwapGate = undefined;
  createSwapStarted = undefined;

  constructor(supported = ["USDT_TRON", "SOL_SOL", "ETH_ETH"], name = "fixedfloat") {
    this.supported = new Set(supported);
    this.name = name;
  }

  async supportedPayInAssets() {
    return new Set(this.supported);
  }

  async payInAssetCatalog() {
    this.catalogCalls += 1;
    return Array.from(this.supported, (payInAsset) => ({
      pay_asset: payInAsset,
      minimum_pay_amount: payInAsset === "ETH_ETH" ? "0.0001" : "1",
      maximum_pay_amount: payInAsset === "ETH_ETH" ? "10" : "5000",
    }));
  }

  async quote(input) {
    this.quoteCalls += 1;
    this.quoteInputs.push(input);
    const { payInAsset } = input;
    return {
      pay_amount: payInAsset === "ETH_ETH" ? "0.0008" : "1.05",
      pay_asset: payInAsset,
      available: true,
      provider: this.name,
    };
  }

  async createSwap(input) {
    this.createCalls += 1;
    this.createSwapInputs.push(input);
    const { payInAsset } = input;
    this.createSwapStarted?.();
    if (this.createSwapGate !== undefined) {
      await this.createSwapGate;
    }
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
    // Stay hermetic: never merge the developer's local openreceive.yml into unit tests.
    configPath: false,
    client: wallet,
    store,
    namespace: "demo_hello_fruit",
    clock: () => now,
    priceProviders: [new StaticPriceProvider()],
    swap: { providers: [] },
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

test("createOpenReceive loads ordered FixedFloat-compatible swaps from YAML config", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-swap-config-"));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      [
        "swap:",
        "  providers:",
        "    - id: otherfloat",
        "      protocol: fixedfloat",
        "      base_url: https://otherfloat.example",
        "      key: otherfloat-key",
        "      secret: otherfloat-secret",
        "      invoice_expiry_seconds: 1620",
        "    - id: fixedfloat",
        "      protocol: fixedfloat",
        "      base_url: https://fixedfloat.example",
        "      key: fixed-float-key",
        "      secret: fixed-float-secret",
        "      invoice_expiry_seconds: 1620",
        "",
      ].join("\n"),
    );

    const fetchCalls = [];
    await withGlobalFetch(
      async (url, options) => {
        fetchCalls.push({
          url: String(url),
          body: JSON.parse(String(options.body)),
        });
        if (String(url).endsWith("/api/v2/ccies")) {
          return jsonResponse({
            code: 0,
            data: [
              {
                code: "USDTTRC",
                coin: "USDT",
                network: "TRC20",
                send: { min: "1", max: "5000" },
              },
              { code: "BTCLN", coin: "BTC", network: "Lightning" },
            ],
          });
        }
        if (String(url) === "https://otherfloat.example/api/v2/price") {
          return jsonResponse({
            code: 0,
            data: {
              from: {
                amount: "1.04",
              },
            },
          });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      async () => {
        const openreceive = await createOpenReceive({
          client: new FakeWallet(() => 1000),
          store: new InMemoryInvoiceKvStore(),
          namespace: "swap_yaml",
          cwd: dir,
          clock: () => 1000,
          priceProviders: [new StaticPriceProvider()],
        });

        await openreceive.createCheckout({
          orderId: "order-swap-yaml",
          amount: { btc: { currency: "SATS", value: "200" } },
        });

        const options = await openreceive.swapOptions({ orderId: "order-swap-yaml" });
        const usdtTron = options.options.find((option) => option.pay_in_asset === "USDT_TRON");
        assert.equal(options.enabled, true);
        assert.equal(usdtTron?.provider, "otherfloat");
        assert.equal(usdtTron?.minimum_pay_amount, "1");
        assert.equal(usdtTron?.maximum_pay_amount, "5000");

        const quote = await openreceive.swapQuote({
          orderId: "order-swap-yaml",
          payInAsset: "USDT_TRON",
        });
        assert.equal(quote.provider, "otherfloat");
        assert.equal(quote.available, true);
        assert.equal(quote.pay_amount, "1.04");
        assert.deepEqual(
          fetchCalls.map((call) => call.url),
          [
            "https://otherfloat.example/api/v2/ccies",
            "https://fixedfloat.example/api/v2/ccies",
            "https://otherfloat.example/api/v2/price",
          ],
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOpenReceive rejects YAML config with partially configured provider secrets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-swap-config-"));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      [
        "swap:",
        "  providers:",
        "    - id: otherfloat",
        "      protocol: fixedfloat",
        "      base_url: https://otherfloat.example",
        "      key: otherfloat-key",
        "",
      ].join("\n"),
    );

    await assert.rejects(
      () =>
        createOpenReceive({
          client: new FakeWallet(() => 1000),
          store: new InMemoryInvoiceKvStore(),
          namespace: "swap_yaml_missing_secret",
          cwd: dir,
          clock: () => 1000,
          priceProviders: [new StaticPriceProvider()],
        }),
      (error) => {
        assert.equal(error instanceof OpenReceiveConfigError, true);
        assert.equal(error.code, "INVALID_CONFIG_FILE");
        assert.match(String(error.cause?.message), /key and .*secret must be set together/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOpenReceive rejects duplicate YAML swap provider ids", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-swap-config-"));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      [
        "swap:",
        "  providers:",
        "    - id: otherfloat",
        "      protocol: fixedfloat",
        "      base_url: https://otherfloat-a.example",
        "      key: otherfloat-a-key",
        "      secret: otherfloat-a-secret",
        "    - id: otherfloat",
        "      protocol: fixedfloat",
        "      base_url: https://otherfloat-b.example",
        "      key: otherfloat-b-key",
        "      secret: otherfloat-b-secret",
        "",
      ].join("\n"),
    );

    await assert.rejects(
      () =>
        createOpenReceive({
          client: new FakeWallet(() => 1000),
          store: new InMemoryInvoiceKvStore(),
          namespace: "swap_yaml_duplicate_ids",
          cwd: dir,
          clock: () => 1000,
          priceProviders: [new StaticPriceProvider()],
        }),
      (error) => {
        assert.equal(error instanceof OpenReceiveConfigError, true);
        assert.equal(error.code, "INVALID_CONFIG_FILE");
        assert.match(String(error.cause?.message), /duplicates swap provider id/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOpenReceive skips blank YAML swap provider secrets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-swap-config-"));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      [
        "swap:",
        "  providers:",
        "    - id: otherfloat",
        "      protocol: fixedfloat",
        "      base_url: https://otherfloat.example",
        '      key: ""',
        '      secret: ""',
        "",
      ].join("\n"),
    );

    const openreceive = await createOpenReceive({
      client: new FakeWallet(() => 1000),
      store: new InMemoryInvoiceKvStore(),
      namespace: "swap_yaml_blank_secret",
      cwd: dir,
      clock: () => 1000,
      priceProviders: [new StaticPriceProvider()],
    });

    await openreceive.createCheckout({
      orderId: "order-swap-yaml-blank",
      amount: { btc: { currency: "SATS", value: "200" } },
    });

    assert.deepEqual(await openreceive.swapOptions({ orderId: "order-swap-yaml-blank" }), {
      enabled: false,
      options: [],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FixedFloat rejects invoice expiry configs shorter than its payout window", () => {
  assert.throws(
    () =>
      fixedFloatProvider({
        key: "fixed-float-key",
        secret: "fixed-float-secret",
        fetch: async () => jsonResponse({ code: 0, data: [] }),
        depositWindowSeconds: 600,
        settlementSlaSeconds: 120,
        invoiceExpiryMarginSeconds: 60,
        invoiceExpirySeconds: 779,
      }),
    /invoice_expiry_seconds \(779\) must be at least 780 = deposit_window\(600\) \+ settlement_sla\(120\) \+ margin\(60\)/,
  );
});

test("FixedFloat quote treats data.errors as unavailable with provider limits", async () => {
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async (url) => {
      if (String(url) === "https://fixedfloat.example/api/v2/ccies") {
        return jsonResponse({
          code: 0,
          data: [
            { code: "USDTTRC", coin: "USDT", network: "TRC20" },
            { code: "BTCLN", coin: "BTC", network: "Lightning" },
          ],
        });
      }
      if (String(url) === "https://fixedfloat.example/api/v2/price") {
        return jsonResponse({
          code: 0,
          data: {
            errors: [{ code: "LIMIT_MIN", msg: "minimum amount" }],
            from: {
              min: "10",
              max: "5000",
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const quote = await provider.quote({
    payInAsset: "USDT_TRON",
    invoiceAmountMsats: 200000,
  });

  assert.equal(quote.available, false);
  assert.equal(quote.unavailable_reason, "amount_too_small");
  assert.equal(quote.minimum_pay_amount, "10");
  assert.equal(quote.maximum_pay_amount, "5000");
});

test("FixedFloat create rejects payout amount mismatches before returning a deposit", async () => {
  const fetchCalls = [];
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async (url, options) => {
      fetchCalls.push({
        url: String(url),
        body: options?.body === undefined ? undefined : JSON.parse(String(options.body)),
      });
      if (String(url) === "https://fixedfloat.example/api/v2/ccies") {
        return jsonResponse({
          code: 0,
          data: [
            { code: "USDTTRC", coin: "USDT", network: "TRC20" },
            { code: "BTCLN", coin: "BTC", network: "Lightning" },
          ],
        });
      }
      if (String(url) === "https://fixedfloat.example/api/v2/create") {
        return jsonResponse({
          code: 0,
          data: {
            id: "ff-order-mismatch",
            token: "ff-token-mismatch",
            status: "NEW",
            from: {
              address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
              amount: "1.05",
            },
            to: {
              amount: "0.000001",
            },
            time: {
              expiration: 1600,
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await assert.rejects(
    () =>
      provider.createSwap({
        payInAsset: "USDT_TRON",
        bolt11: "lnbc-demo-1",
        invoiceAmountMsats: 200000,
      }),
    /payout amount did not match/,
  );
  const createCall = fetchCalls.find(
    (call) => call.url === "https://fixedfloat.example/api/v2/create",
  );
  assert.equal(createCall?.body.direction, "to");
  assert.equal(createCall?.body.toAddress, "lnbc-demo-1");
  assert.equal(createCall?.body.amount, "0.000002");
});

test("FixedFloat create rejects deposit addresses from the wrong network", async () => {
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async (url) => {
      if (String(url) === "https://fixedfloat.example/api/v2/ccies") {
        return jsonResponse({
          code: 0,
          data: [
            { code: "USDTTRC", coin: "USDT", network: "TRC20" },
            { code: "BTCLN", coin: "BTC", network: "Lightning" },
          ],
        });
      }
      if (String(url) === "https://fixedfloat.example/api/v2/create") {
        return jsonResponse({
          code: 0,
          data: {
            id: "ff-order-wrong-network",
            token: "ff-token-wrong-network",
            status: "NEW",
            from: {
              address: "0x1111111111111111111111111111111111111111",
              amount: "1.05",
            },
            to: {
              amount: "0.000002",
            },
            time: {
              expiration: 1600,
            },
          },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  await assert.rejects(
    () =>
      provider.createSwap({
        payInAsset: "USDT_TRON",
        bolt11: "lnbc-demo-1",
        invoiceAmountMsats: 200000,
      }),
    /deposit address is not valid/,
  );
});

test("FixedFloat status reads refunds from back.tx.id and reaches refunded", async () => {
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async (url) => {
      assert.equal(String(url), "https://fixedfloat.example/api/v2/order");
      return jsonResponse({
        code: 0,
        data: {
          id: "ff-order-refund",
          token: "ff-token-refund",
          status: "EMERGENCY",
          emergency: {
            status: ["EXPIRED"],
            choice: "REFUND",
          },
          from: {
            address: "0x1111111111111111111111111111111111111111",
            amount: "0.0008",
          },
          back: {
            tx: {
              id: "0xrefund",
            },
          },
          time: {
            expiration: 1600,
          },
        },
      });
    },
  });

  const order = await provider.getStatus({
    provider: "fixedfloat",
    provider_order_id: "ff-order-refund",
    provider_token: "ff-token-refund",
    pay_in_asset: "ETH_ETH",
    deposit_address: "0x1111111111111111111111111111111111111111",
    deposit_amount: "0.0008",
    expires_at: 1600,
    state: "refund_pending",
  });

  assert.equal(order.state, "refunded");
  assert.equal(order.refund_tx_id, "0xrefund");
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
  assert.equal(
    options.options.some((option) => option.pay_in_asset === "USDT_TRON"),
    true,
  );

  const first = await openreceive.startSwap({
    orderId: "order-swap-start",
    payInAsset: "USDT_TRON",
  });
  const second = await openreceive.startSwap({
    orderId: "order-swap-start",
    payInAsset: "USDT_TRON",
  });

  assert.equal(first.attempt_id, second.attempt_id);
  assert.equal(first.shadow_invoice.rail, "swap");
  assert.equal(first.shadow_invoice.amount_msats, checkout.amount_msats);
  assert.equal(first.provider, "fixedfloat");
  assert.equal(first.attempt_id, first.shadow_invoice.invoice_id);
  assert.equal(first.pay_in_asset, "USDT_TRON");
  assert.equal(first.deposit_address, "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
  assert.equal(first.shadow_invoice.invoice, null);
  assert.equal("provider_token" in first, false);
  assert.equal(wallet.makeInvoiceCalls, 2);
  assert.equal(swapProvider.createCalls, 1);

  const order = await openreceive.getOrder({ orderId: "order-swap-start" });
  assert.equal(order.active_checkout.active.invoice_id, checkout.active.invoice_id);
  assert.equal(order.active_checkout.invoices.length, 2);
  assert.equal(
    order.active_checkout.invoices.some((invoice) => invoice.rail === "swap"),
    true,
  );

  const stored = await store.get(first.attempt_id);
  assert.equal(stored.row.metadata.swap.provider_token, undefined);
  assert.equal(stored.row.metadata.swap_private.provider_token, "ff-token-1");
});

test("openreceive.order routes each action and rides swap_pay_options on the order", async () => {
  const swapProvider = new FakeSwapProvider();
  const { openreceive } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  const checkout = await openreceive.createCheckout({
    orderId: "order-dispatch",
    amount: { btc: { currency: "SATS", value: "200" } },
    memo: "Fruit sticker",
  });

  // Status action (action omitted) returns the order object plus the payable
  // swap assets on swap_pay_options, so listing methods costs no extra call.
  const status = await openreceive.order({ order_id: "order-dispatch" });
  assert.equal(status.order_id, "order-dispatch");
  assert.equal(status.status, "pending");
  assert.equal(status.swaps_enabled, true);
  assert.equal(Array.isArray(status.swap_pay_options), true);
  assert.equal(
    status.swap_pay_options.some((method) => method.pay_in_asset === "USDT_TRON"),
    true,
  );

  // Quote action routes to swapQuote and returns the { quote } envelope.
  const quoted = await openreceive.order({
    order_id: "order-dispatch",
    action: "swap_quote",
    pay_in_asset: "USDT_TRON",
  });
  assert.equal(quoted.quote.provider, "fixedfloat");
  assert.equal(quoted.quote.pay_amount, "1.05");

  // Start action routes to startSwap and returns the { attempt } envelope. It
  // reuses startSwap's duplicate protection: two starts share one shadow
  // invoice and one provider order, and provider tokens never leak.
  const started = await openreceive.order({
    order_id: "order-dispatch",
    action: "start_swap",
    pay_in_asset: "USDT_TRON",
  });
  const restarted = await openreceive.order({
    order_id: "order-dispatch",
    action: "start_swap",
    pay_in_asset: "USDT_TRON",
  });
  assert.equal(started.attempt.shadow_invoice.rail, "swap");
  assert.equal(started.attempt.pay_in_asset, "USDT_TRON");
  assert.equal(started.attempt.deposit_address, "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
  assert.equal(started.attempt.shadow_invoice.invoice, null);
  assert.equal(started.attempt.attempt_id, restarted.attempt.attempt_id);
  assert.equal("provider_token" in started.attempt, false);
  assert.equal(swapProvider.createCalls, 1);

  // The started swap now shows up on the order object without replacing the
  // active Lightning invoice.
  const afterStart = await openreceive.order({ order_id: "order-dispatch" });
  assert.equal(afterStart.active_checkout.active.invoice_id, checkout.active.invoice_id);
  assert.equal(
    afterStart.active_checkout.invoices.some((invoice) => invoice.rail === "swap"),
    true,
  );
});

test("openreceive.order propagates OpenReceiveServiceError status codes (404/409/400)", async () => {
  const swapProvider = new FakeSwapProvider();
  const harness = await createHarness({
    swap: { providers: [swapProvider] },
  });
  const { openreceive } = harness;

  // 404: no order exists for the id.
  await assert.rejects(
    () => openreceive.order({ order_id: "order-dispatch-missing" }),
    (error) => error instanceof OpenReceiveServiceError && error.status === 404,
  );

  await openreceive.createCheckout({
    orderId: "order-dispatch-errors",
    amount: { btc: { currency: "SATS", value: "200" } },
  });

  // 400: unsupported pay-in asset is rejected by the shared parser.
  await assert.rejects(
    () =>
      openreceive.order({
        order_id: "order-dispatch-errors",
        action: "swap_quote",
        pay_in_asset: "NOT_AN_ASSET",
      }),
    (error) => error instanceof OpenReceiveServiceError && error.status === 400,
  );

  // 400: an unrecognized action fails loud instead of silently returning status.
  await assert.rejects(
    () =>
      openreceive.order({
        order_id: "order-dispatch-errors",
        action: "cancel",
      }),
    (error) => error instanceof OpenReceiveServiceError && error.status === 400,
  );

  // 409: after the only checkout expires there is no open checkout to start.
  harness.setNow(5000);
  await assert.rejects(
    () =>
      openreceive.order({
        order_id: "order-dispatch-errors",
        action: "start_swap",
        pay_in_asset: "USDT_TRON",
      }),
    (error) => error instanceof OpenReceiveServiceError && error.status === 409,
  );
});

test("startSwap reserves the attempt before provider create to avoid duplicate orders", async () => {
  const swapProvider = new FakeSwapProvider();
  let releaseCreate;
  swapProvider.createSwapGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const createStarted = new Promise((resolve) => {
    swapProvider.createSwapStarted = resolve;
  });
  const { openreceive } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-reserve-first",
    amount: { btc: { currency: "SATS", value: "200" } },
  });

  const first = openreceive.startSwap({
    orderId: "order-swap-reserve-first",
    payInAsset: "USDT_TRON",
  });
  await createStarted;

  await assert.rejects(
    () =>
      openreceive.startSwap({
        orderId: "order-swap-reserve-first",
        payInAsset: "USDT_TRON",
      }),
    (error) => error instanceof OpenReceiveServiceError && error.status === 409,
  );
  assert.equal(swapProvider.createCalls, 1);

  releaseCreate();
  const invoice = await first;
  assert.equal(invoice.provider_order_id, "ff-order-1");
  assert.equal(swapProvider.createCalls, 1);
});

test("startSwap surfaces a 409 (not a 500) when a stale reserved attempt is replayed", async () => {
  const swapProvider = new FakeSwapProvider();
  let releaseCreate;
  swapProvider.createSwapGate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const createStarted = new Promise((resolve) => {
    swapProvider.createSwapStarted = resolve;
  });
  const harness = await createHarness({ swap: { providers: [swapProvider] } });
  const { openreceive } = harness;
  await openreceive.createCheckout({
    orderId: "order-swap-stale",
    amount: { btc: { currency: "SATS", value: "200" } },
  });

  // First start reserves the record, then hangs inside provider.createSwap, so the
  // record is stuck in creating_provider_order with no deposit address.
  const first = openreceive.startSwap({ orderId: "order-swap-stale", payInAsset: "USDT_TRON" });
  await createStarted;

  // Advance past the creating-provider-order timeout (created_at 1000 + 30s).
  harness.setNow(1040);
  await assert.rejects(
    () => openreceive.startSwap({ orderId: "order-swap-stale", payInAsset: "USDT_TRON" }),
    (error) =>
      error instanceof OpenReceiveServiceError &&
      error.status === 409 &&
      /Start the swap again/.test(error.body?.message ?? ""),
  );

  releaseCreate();
  await first.catch(() => {});
});

test("swapOptions catalogs assets and swapQuote quotes one selected asset", async () => {
  const swapProvider = new FakeSwapProvider();
  const { openreceive } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-region",
    amount: { btc: { currency: "SATS", value: "200" } },
  });

  const options = await openreceive.swapOptions({
    orderId: "order-swap-region",
  });
  const usdt = options.options.find((option) => option.pay_in_asset === "USDT_TRON");
  assert.equal(usdt.available, true);
  assert.equal(usdt.unavailable_reason, undefined);
  assert.equal(usdt.pay_amount, undefined);
  assert.equal(usdt.minimum_pay_amount, "1");
  assert.equal(swapProvider.catalogCalls, 1);
  assert.equal(swapProvider.quoteInputs.length, 0);

  const quote = await openreceive.swapQuote({
    orderId: "order-swap-region",
    payInAsset: "USDT_TRON",
  });
  assert.equal(quote.pay_amount, "1.05");
  assert.equal(
    swapProvider.quoteInputs.every(
      (input) => Object.keys(input).sort().join(",") === "invoiceAmountMsats,payInAsset",
    ),
    true,
  );
  assert.deepEqual(swapProvider.quoteInputs, [
    {
      payInAsset: "USDT_TRON",
      invoiceAmountMsats: 200000,
    },
  ]);

  const cachedQuote = await openreceive.swapQuote({
    orderId: "order-swap-region",
    payInAsset: "USDT_TRON",
  });
  assert.equal(cachedQuote.pay_amount, "1.05");
  assert.equal(swapProvider.quoteInputs.length, 1);

  const invoice = await openreceive.startSwap({
    orderId: "order-swap-region",
    payInAsset: "USDT_TRON",
  });
  assert.equal(invoice.pay_in_asset, "USDT_TRON");
  assert.equal(
    swapProvider.createSwapInputs.every(
      (input) => Object.keys(input).sort().join(",") === "bolt11,invoiceAmountMsats,payInAsset",
    ),
    true,
  );
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

  wallet.settlePaymentHash(swapInvoice.shadow_invoice.payment_hash, 1200);
  setNow(1015);
  const order = await openreceive.getOrder({ orderId: "order-swap-settle" });

  assert.equal(order.status, "paid");
  assert.equal(
    order.paid_checkout.invoices.some((invoice) => invoice.invoice_id === swapInvoice.attempt_id),
    true,
  );
  assert.equal(order.paid_at, 1200);
});

test("settling a shadow swap invoice does not expose provider tokens to onPaid", async () => {
  const swapProvider = new FakeSwapProvider();
  let paidMetadata;
  const { wallet, openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
    onPaid: async ({ metadata }) => {
      paidMetadata = metadata;
    },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-onpaid-private",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  const swapInvoice = await openreceive.startSwap({
    orderId: "order-swap-onpaid-private",
    payInAsset: "SOL_SOL",
  });

  wallet.settlePaymentHash(swapInvoice.shadow_invoice.payment_hash, 1200);
  setNow(1015);
  await openreceive.getOrder({ orderId: "order-swap-onpaid-private" });

  assert.equal(paidMetadata.swap_private, undefined);
  assert.equal(paidMetadata.swap.provider_token, undefined);
  assert.equal(paidMetadata.swap.provider_order_id, "ff-order-1");
});

test("provider completion exposes payout details but does not mark paid without wallet settlement", async () => {
  const swapProvider = new FakeSwapProvider();
  const background = [];
  const { wallet, openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
    waitUntil: (promise) => {
      background.push(promise);
    },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-provider-done",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  await Promise.all(background.splice(0));
  await openreceive.startSwap({
    orderId: "order-swap-provider-done",
    payInAsset: "USDT_TRON",
  });

  swapProvider.nextState = "completed";
  setNow(1015);
  const walletCallsBefore = wallet.listTransactionsCalls;
  const order = await openreceive.getOrder({ orderId: "order-swap-provider-done" });
  const expectedGlobalSweepCalls = order.wallet_scan_performed ? 1 : 0;
  const swapInvoice = order.active_checkout.invoices.find((invoice) => invoice.rail === "swap");

  assert.equal(wallet.listTransactionsCalls - walletCallsBefore, expectedGlobalSweepCalls);
  assert.equal(order.status, "pending");
  assert.equal(swapInvoice.swap.provider_state, "completed");
  assert.equal(swapInvoice.swap.provider_order_id, "ff-order-1");
  assert.equal(swapInvoice.swap.payout_tx_id, "ln-payout-1");
});

test("completed provider orders become attention when wallet settlement never arrives", async () => {
  const swapProvider = new FakeSwapProvider();
  const { openreceive, setNow } = await createHarness({
    swap: {
      providers: [swapProvider],
      settlementAttentionSeconds: 10,
    },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-attention",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  await openreceive.startSwap({
    orderId: "order-swap-attention",
    payInAsset: "USDT_TRON",
  });

  swapProvider.nextState = "completed";
  setNow(1015);
  await openreceive.getOrder({ orderId: "order-swap-attention" });
  setNow(1026);
  const order = await openreceive.getOrder({ orderId: "order-swap-attention" });
  const swapInvoice = order.active_checkout.invoices.find((invoice) => invoice.rail === "swap");

  assert.equal(swapInvoice.swap.provider_state, "attention");
  assert.equal(swapInvoice.swap.attention, true);
});

test("expired local swap invoices still poll provider lifecycle states", async () => {
  const swapProvider = new FakeSwapProvider(["USDT_TRON"]);
  const { openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-expired-local-poll",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  const swapInvoice = await openreceive.startSwap({
    orderId: "order-swap-expired-local-poll",
    payInAsset: "USDT_TRON",
  });

  swapProvider.nextState = "refund_required";
  setNow(swapInvoice.shadow_invoice.expires_at + 20);
  const order = await openreceive.getOrder({ orderId: "order-swap-expired-local-poll" });
  const refreshed = order.checkouts
    .flatMap((checkout) => checkout.invoices)
    .find((invoice) => invoice.invoice_id === swapInvoice.attempt_id);

  assert.equal(swapProvider.statusCalls, 1);
  assert.equal(refreshed.swap.provider_state, "refund_required");
  assert.equal(refreshed.swap.deposit_tx_id, "deposit-tx-1");
  assert.match(refreshed.swap.refund_nonce, /^or_ref_[a-f0-9]{32}$/);
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

  wallet.settlePaymentHash(swapInvoice.shadow_invoice.payment_hash, 1210);
  setNow(1015);
  const order = await openreceive.getOrder({ orderId: "order-swap-supersede" });

  assert.equal(order.status, "paid");
  assert.equal(order.paid_checkout.checkout_id !== replacement.checkout_id, true);
  assert.equal(order.paid_checkout.status, "paid");
  assert.equal(
    order.paid_checkout.invoices.some((invoice) => invoice.invoice_id === swapInvoice.attempt_id),
    true,
  );
});

test("refundSwap requests a provider refund only for refund-required swaps", async () => {
  const swapProvider = new FakeSwapProvider(["USDT_TRON", "SOL_SOL", "ETH_ETH"], "otherfloat");
  const { openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.createCheckout({
    orderId: "order-swap-refund",
    amount: { btc: { currency: "SATS", value: "200" } },
  });
  const swapAttempt = await openreceive.startSwap({
    orderId: "order-swap-refund",
    payInAsset: "ETH_ETH",
  });
  assert.equal(swapAttempt.provider, "otherfloat");

  swapProvider.nextState = "refund_required";
  setNow(1015);
  const refreshed = await openreceive.getOrder({ orderId: "order-swap-refund" });
  const refundRequired = refreshed.active_checkout.invoices.find(
    (invoice) => invoice.rail === "swap",
  );
  assert.equal(refundRequired.swap.provider_state, "refund_required");
  assert.equal(refundRequired.swap.provider, "otherfloat");
  assert.equal(refundRequired.swap.deposit_tx_id, "deposit-tx-1");
  assert.match(refundRequired.swap.refund_nonce, /^or_ref_[a-f0-9]{32}$/);
  // The refund nonce expiry is now surfaced alongside the nonce for countdown UIs.
  assert.equal(refundRequired.swap.refund_nonce_expires_at, 1015 + 10 * 60);

  const submitted = await openreceive.refundSwap({
    attemptId: swapAttempt.attempt_id,
    refundAddress: "0x2222222222222222222222222222222222222222",
    refundNonce: refundRequired.swap.refund_nonce,
  });

  assert.equal(submitted.provider_state, "refund_required");
  assert.equal(submitted.refund_address, "0x2222222222222222222222222222222222222222");
  assert.deepEqual(swapProvider.refundCalls, []);

  const refunded = await openreceive.refundSwap({
    attemptId: swapAttempt.attempt_id,
    refundAddress: "0x2222222222222222222222222222222222222222",
    refundNonce: submitted.refund_nonce,
    confirm: true,
  });

  assert.equal(refunded.provider_state, "refund_pending");
  assert.equal(refunded.refund_address, "0x2222222222222222222222222222222222222222");
  assert.equal(refunded.refund_nonce, undefined);
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
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-price-config-"));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      ["OPENRECEIVE_PRICE_CURRENCIES:", "  - eur", "  - usd", "  - EUR", ""].join("\n"),
    );

    const openreceive = await createOpenReceive({
      client: new FakeWallet(() => 1000),
      store: new InMemoryInvoiceKvStore(),
      namespace: "currency_config",
      cwd: dir,
      clock: () => 1000,
      priceProviders: [new StaticPriceProvider()],
      swap: { providers: [] },
    });

    assert.equal(openreceive.namespace, "currency_config");
    assert.deepEqual(openreceive.priceCurrencies, ["EUR", "USD"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    swap: { providers: [] },
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
          swap: { providers: [] },
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

async function withEnv(env, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    restoreEnvVar(key, value);
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of previous) {
      restoreEnvVar(key, value);
    }
  }
}

async function withGlobalFetch(fetcher, callback) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    await callback();
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}
