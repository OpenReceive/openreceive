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
  makeInvoiceRequests = [];

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
    this.makeInvoiceRequests.push(request);
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

  invoiceExpirySeconds() {
    // Keep the shadow bolt11 ahead of createSwap's provider expires_at (4600 with
    // harness now=1000 → need ≥3600s expiry).
    return 3600;
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
      // Far enough past harness `now` (1000) that post-create shadow-invoice
      // guards and expired-grace polls stay out of the way unless a test overrides.
      expires_at: 4600,
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
    amount: { currency: "BTC", value: "0.000002" },
    memo: "Fruit sticker",
  };

  const first = await openreceive.getOrCreateCheckout(request);
  assert.equal(first.checkoutId.startsWith("or_chk_"), true);
  assert.equal(first.orderId, "order-1");
  assert.equal(first.status, "open");
  assert.equal(first.active.bolt11, "lnbc-demo-1");
  assert.equal(first.amountMsats, 200000);
  assert.equal(first.invoices.length, 1);

  const second = await openreceive.getOrCreateCheckout(request);
  assert.equal(second.checkoutId, first.checkoutId);
  assert.equal(second.active.invoiceId, first.active.invoiceId);
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("createCheckout with mintLightning:false locks amount without calling makeInvoice", async () => {
  const { wallet, openreceive } = await createHarness();
  const locked = await openreceive.getOrCreateCheckout({
    orderId: "order-deferred",
    amount: { sats: "200" },
    mintLightning: false,
  });
  assert.equal(locked.status, "open");
  assert.equal(locked.active, undefined);
  assert.equal(locked.invoices.length, 0);
  assert.equal(locked.amountMsats, 200_000);
  assert.equal(wallet.makeInvoiceCalls, 0);

  const minted = await openreceive.getOrCreateCheckout({
    orderId: "order-deferred",
    amount: { sats: "200" },
    mintLightning: true,
  });
  assert.equal(minted.checkoutId, locked.checkoutId);
  assert.equal(minted.active?.bolt11.startsWith("lnbc"), true);
  assert.equal(wallet.makeInvoiceCalls, 1);

  const reused = await openreceive.getOrCreateCheckout({
    orderId: "order-deferred",
    amount: { sats: "200" },
    mintLightning: true,
  });
  assert.equal(reused.active?.invoiceId, minted.active?.invoiceId);
  assert.equal(wallet.makeInvoiceCalls, 1);
});

test("createCheckout remints Lightning when the active invoice is within the reuse buffer", async () => {
  const { wallet, openreceive, setNow } = await createHarness();
  const first = await openreceive.getOrCreateCheckout({
    orderId: "order-near-expiry",
    amount: { sats: "200" },
  });
  assert.equal(wallet.makeInvoiceCalls, 1);
  // Default expiry is 600s from created_at (~1000). Jump to within the 60s reuse buffer.
  setNow(first.active.expiresAt - 30);
  const reminted = await openreceive.getOrCreateCheckout({
    orderId: "order-near-expiry",
    amount: { sats: "200" },
    mintLightning: true,
  });
  assert.notEqual(reminted.checkoutId, first.checkoutId);
  assert.notEqual(reminted.active?.invoiceId, first.active.invoiceId);
  assert.equal(wallet.makeInvoiceCalls, 2);
});

test("swapOptions are disabled unless a swap provider is configured", async () => {
  const { openreceive } = await createHarness();
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-disabled",
    amount: { sats: "200" },
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
        "    - base_url: https://otherfloat.example",
        "      key: otherfloat-key",
        "      secret: otherfloat-secret",
        "    - base_url: https://fixedfloat.example",
        "      key: fixed-float-key",
        "      secret: fixed-float-secret",
        "",
      ].join("\n"),
    );

    const fetchCalls = [];
    await withGlobalFetch(
      async (url, options) => {
        const href = String(url);
        fetchCalls.push({
          url: href,
          body:
            options?.body === undefined || options.body === null || options.body === ""
              ? undefined
              : JSON.parse(String(options.body)),
        });
        if (href.endsWith("/api/v2/ccies")) {
          return jsonResponse({
            code: 0,
            data: [
              {
                code: "USDTTRC",
                coin: "USDT",
                network: "TRC20",
                recv: true,
                send: true,
              },
              { code: "BTCLN", coin: "BTC", network: "Lightning" },
            ],
          });
        }
        if (href.endsWith("/rates/fixed.xml")) {
          // Reference rate: 1.04 USDT pays for 0.000002 BTC (200 sats) — matches the
          // checkout amount so the indicative quote equals the old /price fixture.
          return xmlResponse(`<?xml version="1.0"?>
<rates>
  <item>
    <from>USDTTRC</from>
    <to>BTCLN</to>
    <in>1.04</in>
    <out>0.000002</out>
    <amount>1</amount>
    <minamount>1</minamount>
    <maxamount>5000</maxamount>
  </item>
</rates>`);
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

        await openreceive.getOrCreateCheckout({
          orderId: "order-swap-yaml",
          amount: { sats: "200" },
        });

        const options = await openreceive.swapOptions({ orderId: "order-swap-yaml" });
        const usdtTron = options.options.find((option) => option.payInAsset === "USDT_TRON");
        assert.equal(options.enabled, true);
        assert.equal(usdtTron?.provider, "otherfloat-example");
        assert.equal(usdtTron?.minimumPayAmount, "1");
        assert.equal(usdtTron?.maximumPayAmount, "5000");

        const quote = await openreceive.swapQuote({
          orderId: "order-swap-yaml",
          payInAsset: "USDT_TRON",
        });
        assert.equal(quote.provider, "otherfloat-example");
        assert.equal(quote.available, true);
        assert.equal(quote.payAmount, "1.04");
        // Catalog warms /ccies + global XML rates per provider. Quote reuses the
        // cached rates blob — no authenticated /price calls for display quotes.
        assert.deepEqual(
          fetchCalls.map((call) => call.url),
          [
            "https://otherfloat.example/api/v2/ccies",
            "https://otherfloat.example/rates/fixed.xml",
            "https://fixedfloat.example/api/v2/ccies",
            "https://fixedfloat.example/rates/fixed.xml",
          ],
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOpenReceive warns and ignores YAML providers with incomplete secrets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-swap-config-"));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      [
        "swap:",
        "  providers:",
        "    - base_url: https://otherfloat.example",
        "      key: otherfloat-key",
        "",
      ].join("\n"),
    );

    const openreceive = await createOpenReceive({
      client: new FakeWallet(() => 1000),
      store: new InMemoryInvoiceKvStore(),
      namespace: "swap_yaml_missing_secret",
      cwd: dir,
      clock: () => 1000,
      priceProviders: [new StaticPriceProvider()],
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ignoring swap provider "otherfloat-example"/);
    assert.match(warnings[0], /secret is not set/);

    await openreceive.getOrCreateCheckout({
      orderId: "order-swap-yaml-partial",
      amount: { sats: "200" },
    });
    assert.deepEqual(await openreceive.swapOptions({ orderId: "order-swap-yaml-partial" }), {
      enabled: false,
      options: [],
    });
  } finally {
    console.warn = originalWarn;
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
        "    - base_url: https://otherfloat.example",
        "      key: otherfloat-a-key",
        "      secret: otherfloat-a-secret",
        "    - base_url: https://otherfloat.example/",
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
        assert.match(String(error.cause?.message), /duplicates swap provider id "otherfloat-example"/);
        assert.match(String(error.cause?.message), /derived from base_url/);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOpenReceive accepts explicit YAML swap provider id override", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-swap-config-"));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      [
        "swap:",
        "  providers:",
        "    - id: primary",
        "      base_url: https://ff.io",
        "      key: ff-key",
        "      secret: ff-secret",
        "",
      ].join("\n"),
    );

    await withGlobalFetch(
      async (url) => {
        const href = String(url);
        if (href.endsWith("/api/v2/ccies")) {
          return jsonResponse({
            code: 0,
            data: [
              {
                code: "USDTTRC",
                coin: "USDT",
                network: "TRC20",
                recv: true,
                send: true,
              },
              { code: "BTCLN", coin: "BTC", network: "Lightning" },
            ],
          });
        }
        if (href.endsWith("/rates/fixed.xml")) {
          return xmlResponse(`<?xml version="1.0"?>
<rates>
  <item>
    <from>USDTTRC</from>
    <to>BTCLN</to>
    <in>1.04</in>
    <out>0.000002</out>
    <amount>1</amount>
    <minamount>1</minamount>
    <maxamount>5000</maxamount>
  </item>
</rates>`);
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      async () => {
        const openreceive = await createOpenReceive({
          client: new FakeWallet(() => 1000),
          store: new InMemoryInvoiceKvStore(),
          namespace: "swap_yaml_explicit_id",
          cwd: dir,
          clock: () => 1000,
          priceProviders: [new StaticPriceProvider()],
        });

        await openreceive.getOrCreateCheckout({
          orderId: "order-swap-explicit-id",
          amount: { sats: "200" },
        });
        const options = await openreceive.swapOptions({ orderId: "order-swap-explicit-id" });
        assert.equal(
          options.options.find((option) => option.payInAsset === "USDT_TRON")?.provider,
          "primary",
        );
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOpenReceive skips blank YAML swap provider secrets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-swap-config-"));
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      [
        "swap:",
        "  providers:",
        "    - base_url: https://otherfloat.example",
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

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ignoring swap provider "otherfloat-example"/);
    assert.match(warnings[0], /key and secret are not set/);

    await openreceive.getOrCreateCheckout({
      orderId: "order-swap-yaml-blank",
      amount: { sats: "200" },
    });

    assert.deepEqual(await openreceive.swapOptions({ orderId: "order-swap-yaml-blank" }), {
      enabled: false,
      options: [],
    });
  } finally {
    console.warn = originalWarn;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createOpenReceive refuses to boot without OPENRECEIVE_NWC", async () => {
  await assert.rejects(
    () =>
      createOpenReceive({
        store: new InMemoryInvoiceKvStore(),
        namespace: "missing_nwc",
        configPath: false,
        priceProviders: [new StaticPriceProvider()],
      }),
    (error) => {
      assert.equal(error instanceof OpenReceiveConfigError, true);
      assert.equal(error.code, "MISSING_NWC");
      return true;
    },
  );
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

test("FixedFloat quote treats XML min below invoice as unavailable with provider limits", async () => {
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
      if (String(url) === "https://fixedfloat.example/rates/fixed.xml") {
        // 10 USDT min at 315 USDT per 0.005 BTC → ~15_874 sats floor; 200-sat invoice is below.
        return xmlResponse(`<?xml version="1.0"?>
<rates>
  <item>
    <from>USDTTRC</from>
    <to>BTCLN</to>
    <in>315</in>
    <out>0.005</out>
    <amount>1000</amount>
    <minamount>10</minamount>
    <maxamount>5000</maxamount>
  </item>
</rates>`);
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

test("FixedFloat quote and catalog gate ETH when XML out is padded past 8 decimals", async () => {
  // Live FixedFloat pads <out> like 0.028314000000. Invoice-side conversion must still
  // produce minimum_invoice_amount_msats so a $2-class invoice is marked unavailable
  // before /create returns "Out of limits".
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async (url) => {
      if (String(url) === "https://fixedfloat.example/api/v2/ccies") {
        return jsonResponse({
          code: 0,
          data: [
            { code: "ETH", coin: "ETH", network: "ERC20" },
            { code: "BTCLN", coin: "BTC", network: "Lightning" },
          ],
        });
      }
      if (String(url) === "https://fixedfloat.example/rates/fixed.xml") {
        return xmlResponse(`<?xml version="1.0"?>
<rates>
  <item>
    <from>ETH</from>
    <to>BTCLN</to>
    <in>1</in>
    <out>0.028314000000</out>
    <amount>207.22797276</amount>
    <tofee>0.0000016000 BTCLN</tofee>
    <minamount>0.0083927593</minamount>
    <maxamount>6.2933949000</maxamount>
  </item>
</rates>`);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const catalog = await provider.payInAssetCatalog();
  const eth = catalog.find((item) => item.pay_asset === "ETH_ETH");
  assert.equal(eth?.minimum_pay_amount, "0.0083927593");
  assert.equal(eth?.minimum_invoice_amount_msats, 23_764_000);

  const quote = await provider.quote({
    payInAsset: "ETH_ETH",
    invoiceAmountMsats: 3_185_000,
  });
  assert.equal(quote.available, false);
  assert.equal(quote.unavailable_reason, "amount_too_small");
  assert.equal(quote.minimum_invoice_amount_msats, 23_764_000);
});

test("FixedFloat quote folds the pay-in floor into the invoice-side minimum", async () => {
  // XML minamount is 10 USDT; at 315 USDT per 0.005 BTC that is ~15,873 sats.
  // The reported invoice-side minimum must reflect the binding pay-in floor.
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
      if (String(url) === "https://fixedfloat.example/rates/fixed.xml") {
        return xmlResponse(`<?xml version="1.0"?>
<rates>
  <item>
    <from>USDTTRC</from>
    <to>BTCLN</to>
    <in>315</in>
    <out>0.005</out>
    <amount>1000</amount>
    <minamount>10</minamount>
    <maxamount>11340</maxamount>
  </item>
</rates>`);
      }
      throw new Error(`unexpected fetch ${url}`);
    },
  });

  const quote = await provider.quote({
    payInAsset: "USDT_TRON",
    invoiceAmountMsats: 500_000_000,
  });

  assert.equal(quote.available, true);
  assert.equal(quote.minimum_pay_amount, "10");
  // ceil(10 / (315 / 500000)) = ceil(15873.01) = 15874 sats -> 15,874,000 msats
  assert.equal(quote.minimum_invoice_amount_msats, 15_874_000);
  // floor(11340 / (315 / 500000)) = floor(18,000,000) sats
  assert.equal(quote.maximum_invoice_amount_msats, 18_000_000_000);
  // 0.005 BTC invoice at this rate → 315 USDT
  assert.equal(quote.pay_amount, "315");
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
  const checkout = await openreceive.getOrCreateCheckout({
    orderId: "order-swap-start",
    amount: { sats: "200" },
    memo: "Fruit sticker",
  });

  const options = await openreceive.swapOptions({ orderId: "order-swap-start" });
  assert.equal(options.enabled, true);
  assert.equal(
    options.options.some((option) => option.payInAsset === "USDT_TRON"),
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

  assert.equal(first.attemptId, second.attemptId);
  assert.equal(first.shadowInvoice.rail, "swap");
  assert.equal(first.shadowInvoice.amountMsats, checkout.amountMsats);
  assert.equal(first.provider, "fixedfloat");
  assert.equal(first.attemptId, first.shadowInvoice.invoiceId);
  assert.equal(first.payInAsset, "USDT_TRON");
  assert.equal(first.depositAddress, "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
  assert.equal(typeof first.shadowInvoice.bolt11, "string");
  assert.equal("provider_token" in first, false);
  assert.equal(wallet.makeInvoiceCalls, 2);
  assert.equal(swapProvider.createCalls, 1);
  // The display invoice keeps the merchant memo verbatim; the swap shadow invoice
  // appends the provider and pay-in currency so the settled wallet payment is
  // attributable. The pay-in amount is not yet known at this point, so it is absent.
  assert.equal(wallet.makeInvoiceRequests[0].description, "Fruit sticker");
  assert.equal(
    wallet.makeInvoiceRequests[1].description,
    "Fruit sticker · via fixedfloat, paid in USDT (Tron)",
  );

  const order = await openreceive.getOrder({ orderId: "order-swap-start" });
  assert.equal(order.activeCheckout.active.invoiceId, checkout.active.invoiceId);
  assert.equal(order.activeCheckout.invoices.length, 2);
  assert.equal(
    order.activeCheckout.invoices.some((invoice) => invoice.rail === "swap"),
    true,
  );

  const stored = await store.get(first.attemptId);
  assert.equal(stored.row.metadata.swap.provider_token, undefined);
  assert.equal(stored.row.metadata.swap_private.provider_token, "ff-token-1");
});

test("typed swap methods compose order status and reuse startSwap protection", async () => {
  const swapProvider = new FakeSwapProvider();
  const { openreceive } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  const checkout = await openreceive.getOrCreateCheckout({
    orderId: "order-dispatch",
    amount: { sats: "200" },
    memo: "Fruit sticker",
  });

  const order = await openreceive.getOrder({ orderId: "order-dispatch" });
  const swap = await openreceive.swapOptions({ orderId: "order-dispatch" });
  assert.equal(order.orderId, "order-dispatch");
  assert.equal(order.status, "pending");
  assert.equal(swap.enabled, true);
  assert.equal(
    swap.options.some((method) => method.payInAsset === "USDT_TRON"),
    true,
  );

  const quote = await openreceive.swapQuote({
    orderId: "order-dispatch",
    payInAsset: "USDT_TRON",
  });
  assert.equal(quote.provider, "fixedfloat");
  assert.equal(quote.payAmount, "1.05");

  const started = await openreceive.startSwap({
    orderId: "order-dispatch",
    payInAsset: "USDT_TRON",
  });
  const restarted = await openreceive.startSwap({
    orderId: "order-dispatch",
    payInAsset: "USDT_TRON",
  });
  assert.equal(started.shadowInvoice.rail, "swap");
  assert.equal(started.payInAsset, "USDT_TRON");
  assert.equal(started.depositAddress, "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb");
  assert.equal(typeof started.shadowInvoice.bolt11, "string");
  assert.equal(started.attemptId, restarted.attemptId);
  assert.equal("provider_token" in started, false);
  assert.equal(swapProvider.createCalls, 1);

  const afterStart = await openreceive.getOrder({ orderId: "order-dispatch" });
  assert.equal(afterStart.activeCheckout.active.invoiceId, checkout.active.invoiceId);
  assert.equal(
    afterStart.activeCheckout.invoices.some((invoice) => invoice.rail === "swap"),
    true,
  );
});

test("typed swap methods propagate OpenReceiveServiceError status codes (404/409/400)", async () => {
  const swapProvider = new FakeSwapProvider();
  const harness = await createHarness({
    swap: { providers: [swapProvider] },
  });
  const { openreceive } = harness;

  await assert.rejects(
    () => openreceive.getOrder({ orderId: "order-dispatch-missing" }),
    (error) => error instanceof OpenReceiveServiceError && error.status === 404,
  );

  await openreceive.getOrCreateCheckout({
    orderId: "order-dispatch-errors",
    amount: { sats: "200" },
  });

  await assert.rejects(
    () =>
      openreceive.swapQuote({
        orderId: "order-dispatch-errors",
        payInAsset: "NOT_AN_ASSET",
      }),
    (error) => error instanceof OpenReceiveServiceError && error.status === 400,
  );

  harness.setNow(5000);
  await assert.rejects(
    () =>
      openreceive.startSwap({
        orderId: "order-dispatch-errors",
        payInAsset: "USDT_TRON",
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
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-reserve-first",
    amount: { sats: "200" },
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
  assert.equal(invoice.providerOrderId, "ff-order-1");
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
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-stale",
    amount: { sats: "200" },
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
  const logs = [];
  const { openreceive } = await createHarness({
    swap: { providers: [swapProvider] },
    logger: (entry) => logs.push(entry),
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-region",
    amount: { sats: "200" },
  });

  const options = await openreceive.swapOptions({
    orderId: "order-swap-region",
  });
  const usdt = options.options.find((option) => option.payInAsset === "USDT_TRON");
  assert.equal(usdt.available, true);
  assert.equal(usdt.unavailableReason, undefined);
  // The catalog listing gates on provider catalog min/max (from the global rates
  // cache for FixedFloat) and does not quote for display.
  assert.equal(usdt.payAmount, undefined);
  assert.equal(usdt.minimumPayAmount, "1");
  assert.equal(swapProvider.catalogCalls, 1);
  // Fake providers that embed limits in payInAssetCatalog need no quote probes.
  assert.equal(swapProvider.quoteInputs.length, 0);

  const resolvedLog = logs.find((entry) => entry.event === "swap.options.resolved");
  assert.notEqual(resolvedLog, undefined);
  assert.equal(resolvedLog.level, "debug");
  assert.equal(resolvedLog.options, undefined);
  assert.equal(resolvedLog.option_count, options.options.length);
  assert.equal(
    resolvedLog.available_count,
    options.options.filter((option) => option.available).length,
  );
  assert.deepEqual(
    [...resolvedLog.pay_in_assets].sort(),
    options.options.map((option) => option.payInAsset).sort(),
  );

  // A second listing reuses the catalog — still no quotes.
  await openreceive.swapOptions({ orderId: "order-swap-region" });
  assert.equal(swapProvider.quoteInputs.length, 0);
  assert.equal(swapProvider.catalogCalls, 2);

  // Selecting an asset issues an interactive quote at the real invoice amount.
  const quote = await openreceive.swapQuote({
    orderId: "order-swap-region",
    payInAsset: "USDT_TRON",
  });
  assert.equal(quote.payAmount, "1.05");
  assert.equal(swapProvider.quoteInputs.length, 1);
  assert.deepEqual(swapProvider.quoteInputs[0], {
    payInAsset: "USDT_TRON",
    invoiceAmountMsats: 200000,
  });

  // The interactive quote is served from the durable 15s cache on repeat.
  const cachedQuote = await openreceive.swapQuote({
    orderId: "order-swap-region",
    payInAsset: "USDT_TRON",
  });
  assert.equal(cachedQuote.payAmount, "1.05");
  assert.equal(swapProvider.quoteInputs.length, 1);

  const invoice = await openreceive.startSwap({
    orderId: "order-swap-region",
    payInAsset: "USDT_TRON",
  });
  assert.equal(invoice.payInAsset, "USDT_TRON");
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
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-settle",
    amount: { sats: "200" },
  });
  const swapInvoice = await openreceive.startSwap({
    orderId: "order-swap-settle",
    payInAsset: "SOL_SOL",
  });

  wallet.settlePaymentHash(swapInvoice.shadowInvoice.paymentHash, 1200);
  setNow(1015);
  const order = await openreceive.getOrder({ orderId: "order-swap-settle" });

  assert.equal(order.status, "paid");
  assert.equal(
    order.paidCheckout.invoices.some((invoice) => invoice.invoiceId === swapInvoice.attemptId),
    true,
  );
  assert.equal(order.paidAt, 1200);
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
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-onpaid-private",
    amount: { sats: "200" },
  });
  const swapInvoice = await openreceive.startSwap({
    orderId: "order-swap-onpaid-private",
    payInAsset: "SOL_SOL",
  });

  wallet.settlePaymentHash(swapInvoice.shadowInvoice.paymentHash, 1200);
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
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-provider-done",
    amount: { sats: "200" },
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
  const expectedGlobalSweepCalls = order.walletScanPerformed ? 1 : 0;
  const swapInvoice = order.activeCheckout.invoices.find((invoice) => invoice.rail === "swap");

  assert.equal(wallet.listTransactionsCalls - walletCallsBefore, expectedGlobalSweepCalls);
  assert.equal(order.status, "pending");
  assert.equal(swapInvoice.swap.providerState, "completed");
  assert.equal(swapInvoice.swap.providerOrderId, "ff-order-1");
  assert.equal(swapInvoice.swap.payoutTxId, "ln-payout-1");
});

test("completed provider orders become attention when wallet settlement never arrives", async () => {
  const swapProvider = new FakeSwapProvider();
  const { openreceive, setNow } = await createHarness({
    swap: {
      providers: [swapProvider],
      settlementAttentionSeconds: 10,
    },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-attention",
    amount: { sats: "200" },
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
  const swapInvoice = order.activeCheckout.invoices.find((invoice) => invoice.rail === "swap");

  assert.equal(swapInvoice.swap.providerState, "attention");
  assert.equal(swapInvoice.swap.attention, true);
});

test("expired local swap invoices still poll provider lifecycle states", async () => {
  const swapProvider = new FakeSwapProvider(["USDT_TRON"]);
  const { openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-expired-local-poll",
    amount: { sats: "200" },
  });
  const swapInvoice = await openreceive.startSwap({
    orderId: "order-swap-expired-local-poll",
    payInAsset: "USDT_TRON",
  });

  swapProvider.nextState = "refund_required";
  setNow(swapInvoice.shadowInvoice.expiresAt + 20);
  const order = await openreceive.getOrder({ orderId: "order-swap-expired-local-poll" });
  const refreshed = order.checkouts
    .flatMap((checkout) => checkout.invoices)
    .find((invoice) => invoice.invoiceId === swapInvoice.attemptId);

  assert.equal(swapProvider.statusCalls, 1);
  assert.equal(refreshed.swap.providerState, "refund_required");
  assert.equal(refreshed.swap.depositTxId, "deposit-tx-1");
  assert.match(refreshed.swap.refundNonce, /^or_ref_[a-f0-9]{32}$/);
});

test("a superseded checkout is still paid when its shadow invoice settles later", async () => {
  const swapProvider = new FakeSwapProvider();
  const { wallet, openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-supersede",
    amount: { sats: "200" },
  });
  const swapInvoice = await openreceive.startSwap({
    orderId: "order-swap-supersede",
    payInAsset: "USDT_TRON",
  });
  const replacement = await openreceive.getOrCreateCheckout({
    orderId: "order-swap-supersede",
    amount: { sats: "300" },
  });

  wallet.settlePaymentHash(swapInvoice.shadowInvoice.paymentHash, 1210);
  setNow(1015);
  const order = await openreceive.getOrder({ orderId: "order-swap-supersede" });

  assert.equal(order.status, "paid");
  assert.equal(order.paidCheckout.checkoutId !== replacement.checkoutId, true);
  assert.equal(order.paidCheckout.status, "paid");
  assert.equal(
    order.paidCheckout.invoices.some((invoice) => invoice.invoiceId === swapInvoice.attemptId),
    true,
  );
});

test("refundSwap requests a provider refund only for refund-required swaps", async () => {
  const swapProvider = new FakeSwapProvider(["USDT_TRON", "SOL_SOL", "ETH_ETH"], "otherfloat");
  const { openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-refund",
    amount: { sats: "200" },
  });
  const swapAttempt = await openreceive.startSwap({
    orderId: "order-swap-refund",
    payInAsset: "ETH_ETH",
  });
  assert.equal(swapAttempt.provider, "otherfloat");

  swapProvider.nextState = "refund_required";
  setNow(1015);
  const refreshed = await openreceive.getOrder({ orderId: "order-swap-refund" });
  const refundRequired = refreshed.activeCheckout.invoices.find(
    (invoice) => invoice.rail === "swap",
  );
  assert.equal(refundRequired.swap.providerState, "refund_required");
  assert.equal(refundRequired.swap.provider, "otherfloat");
  assert.equal(refundRequired.swap.depositTxId, "deposit-tx-1");
  assert.match(refundRequired.swap.refundNonce, /^or_ref_[a-f0-9]{32}$/);
  // The refund nonce expiry is now surfaced alongside the nonce for countdown UIs.
  assert.equal(refundRequired.swap.refundNonceExpiresAt, 1015 + 10 * 60);

  const submitted = await openreceive.refundSwap({
    attemptId: swapAttempt.attemptId,
    refundAddress: "0x2222222222222222222222222222222222222222",
    refundNonce: refundRequired.swap.refundNonce,
  });

  assert.equal(submitted.providerState, "refund_required");
  assert.equal(submitted.refundAddress, "0x2222222222222222222222222222222222222222");
  assert.deepEqual(swapProvider.refundCalls, []);

  const refunded = await openreceive.refundSwap({
    attemptId: swapAttempt.attemptId,
    refundAddress: "0x2222222222222222222222222222222222222222",
    refundNonce: submitted.refundNonce,
    confirm: true,
  });

  assert.equal(refunded.providerState, "refund_pending");
  assert.equal(refunded.refundAddress, "0x2222222222222222222222222222222222222222");
  assert.equal(refunded.refundNonce, undefined);
  assert.deepEqual(swapProvider.refundCalls, [
    {
      provider_order_id: "ff-order-1",
      refundAddress: "0x2222222222222222222222222222222222222222",
    },
  ]);
});

test("refundSwap rejects refund addresses that do not match the pay-in network", async () => {
  const swapProvider = new FakeSwapProvider(["ETH_ETH"], "otherfloat");
  const { openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-refund-bad-address",
    amount: { sats: "200" },
  });
  const swapAttempt = await openreceive.startSwap({
    orderId: "order-swap-refund-bad-address",
    payInAsset: "ETH_ETH",
  });

  swapProvider.nextState = "refund_required";
  setNow(1015);
  const refreshed = await openreceive.getOrder({ orderId: "order-swap-refund-bad-address" });
  const refundRequired = refreshed.activeCheckout.invoices.find(
    (invoice) => invoice.rail === "swap",
  );
  assert.match(refundRequired.swap.refundNonce, /^or_ref_[a-f0-9]{32}$/);

  await assert.rejects(
    () =>
      openreceive.refundSwap({
        attemptId: swapAttempt.attemptId,
        refundAddress: "7EqQdEULxWcraVQ3XXtK5nGJm6tQ3nqJkGqZQ6c8bqKx",
        refundNonce: refundRequired.swap.refundNonce,
      }),
    (error) =>
      error instanceof OpenReceiveServiceError &&
      error.status === 400 &&
      error.code === "INVALID_REQUEST" &&
      /refund_address is not valid/.test(error.message),
  );
  assert.deepEqual(swapProvider.refundCalls, []);
});

test("createCheckout creates a new checkout and supersedes the open checkout for a different amount", async () => {
  const { wallet, openreceive } = await createHarness();

  const first = await openreceive.getOrCreateCheckout({
    orderId: "order-conflict",
    amount: { currency: "BTC", value: "0.000002" },
  });

  const second = await openreceive.getOrCreateCheckout({
    orderId: "order-conflict",
    amount: { currency: "BTC", value: "0.000003" },
  });
  assert.notEqual(second.checkoutId, first.checkoutId);
  assert.equal(second.status, "open");
  assert.equal(second.amountMsats, 300000);
  assert.equal(wallet.makeInvoiceCalls, 2);

  const order = await openreceive.getOrder({ orderId: "order-conflict" });
  assert.equal(order.status, "pending");
  assert.equal(order.activeCheckout.checkoutId, second.checkoutId);
  assert.equal(order.displayCheckout.checkoutId, second.checkoutId);
  assert.equal(order.checkouts.length, 2);
  assert.equal(
    order.checkouts.find((checkout) => checkout.checkoutId === first.checkoutId).status,
    "superseded",
  );
});

test("createCheckout creates a new checkout after expiry when called again", async () => {
  const { wallet, store, openreceive, setNow } = await createHarness();
  const first = await openreceive.getOrCreateCheckout({
    orderId: "order-retry",
    amount: { sats: "200" },
    memo: "Fruit sticker",
  });

  setNow(1700);
  const expiredOrder = await openreceive.getOrder({ orderId: "order-retry" });
  assert.equal(expiredOrder.status, "expired");
  assert.equal(expiredOrder.activeCheckout, undefined);
  assert.equal(expiredOrder.displayCheckout.checkoutId, first.checkoutId);
  assert.equal(expiredOrder.checkouts[0].checkoutId, first.checkoutId);
  assert.equal(expiredOrder.checkouts[0].status, "expired");
  assert.equal(wallet.makeInvoiceCalls, 1);

  const retried = await openreceive.getOrCreateCheckout({
    orderId: "order-retry",
    amount: { sats: "200" },
    memo: "Fruit sticker",
  });
  const replayed = await openreceive.getOrCreateCheckout({
    orderId: "order-retry",
    amount: { sats: "200" },
    memo: "Fruit sticker",
  });

  assert.notEqual(retried.checkoutId, first.checkoutId);
  assert.notEqual(retried.active.invoiceId, first.active.invoiceId);
  assert.equal(replayed.checkoutId, retried.checkoutId);
  assert.equal(replayed.active.invoiceId, retried.active.invoiceId);
  assert.equal(retried.invoices.length, 1);
  assert.equal(retried.invoices[0].refreshedFromInvoiceId, undefined);
  assert.equal(wallet.makeInvoiceCalls, 2);

  const storedRetry = (await store.get(retried.active.invoiceId)).row;
  assert.equal(storedRetry.operation, "invoice.create");
  assert.equal(storedRetry.metadata.order_id, "order-retry");
  assert.equal(storedRetry.metadata.checkout_id, retried.checkoutId);
  assert.deepEqual(storedRetry.metadata.amount_spec, {
    sats: "200",
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
  const fiatFirst = await fiatHarness.openreceive.getOrCreateCheckout({
    orderId: "order-fiat-retry",
    amount: { currency: "USD", value: "0.05" },
  });
  assert.equal(fiatFirst.amountMsats, 50000);

  btcUsd = "50000.00";
  fiatHarness.setNow(1700);
  const fiatRenewed = await fiatHarness.openreceive.getOrCreateCheckout({
    orderId: "order-fiat-retry",
    amount: { currency: "USD", value: "0.05" },
  });
  assert.equal(fiatRenewed.amountMsats, 100000);
  assert.notEqual(fiatRenewed.checkoutId, fiatFirst.checkoutId);

  const fixedHarness = await createHarness();
  const fixedFirst = await fixedHarness.openreceive.getOrCreateCheckout({
    orderId: "order-fixed-retry",
    amount: { sats: "7000" },
  });
  fixedHarness.setNow(1700);
  const fixedRenewed = await fixedHarness.openreceive.getOrCreateCheckout({
    orderId: "order-fixed-retry",
    amount: { sats: "7000" },
  });
  assert.equal(fixedRenewed.amountMsats, fixedFirst.amountMsats);
  assert.notEqual(fixedRenewed.checkoutId, fixedFirst.checkoutId);
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
      assert.equal(checkoutId, first.checkoutId);
      assert.equal(invoiceId, first.active.invoiceId);
      assert.equal(paymentHash, first.active.paymentHash);
      assert.equal(amountMsats, 200000);
      assert.equal(metadata.cart_id, "cart-123");
      assert.equal(metadata.checkout_id, first.checkoutId);
      assert.equal(invoice.transaction_state, "settled");
    },
  });
  const first = await openreceive.getOrCreateCheckout({
    orderId: "order-late-paid",
    amount: { currency: "BTC", value: "0.000002" },
    metadata: {
      cart_id: "cart-123",
      checkout_id: "must-not-overwrite",
    },
  });
  const superseding = await openreceive.getOrCreateCheckout({
    orderId: "order-late-paid",
    amount: { currency: "BTC", value: "0.000003" },
  });

  wallet.settlePaymentHash(first.active.paymentHash, 1200);
  setNow(1002);
  const order = await openreceive.getOrder({
    orderId: "order-late-paid",
  });

  assert.equal(order.paid, true);
  assert.equal(order.status, "paid");
  assert.equal(order.paidAt, 1200);
  assert.equal(order.paidCheckout.checkoutId, first.checkoutId);
  assert.equal(order.displayCheckout.checkoutId, first.checkoutId);
  assert.equal(order.paidCheckout.amountMsats, 200000);
  assert.equal(order.checkouts.length, 2);
  assert.equal(
    order.checkouts.some((checkout) => checkout.checkoutId === superseding.checkoutId),
    true,
  );
  assert.equal(order.walletScanPerformed, true);
  assert.equal(order.transactionsChecked, 2);
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

  const orderA = await openreceive.getOrCreateCheckout({
    orderId: "order-closed-a",
    amount: { currency: "BTC", value: "0.000002" },
  });
  await Promise.all(background.splice(0));
  setNow(1003);
  const orderB = await openreceive.getOrCreateCheckout({
    orderId: "order-active-b",
    amount: { currency: "BTC", value: "0.000003" },
  });
  await Promise.all(background.splice(0));

  wallet.settlePaymentHash(orderA.active.paymentHash, 1200);
  setNow(1005);
  const bStatus = await openreceive.getOrder({ orderId: "order-active-b" });
  const aStored = await store.get(orderA.active.invoiceId);

  assert.equal(bStatus.orderId, "order-active-b");
  assert.equal(bStatus.paid, false);
  assert.equal(bStatus.activeCheckout.checkoutId, orderB.checkoutId);
  assert.equal(bStatus.walletScanPerformed, true);
  assert.equal(aStored.row.transaction_state, "settled");
  assert.equal(aStored.row.workflow_state, "settlement_action_completed");
  assert.equal(aStored.row.settled_at, 1200);
  assert.equal(paid.length, 1);
  assert.equal(paid[0].orderId, "order-closed-a");
  assert.equal(paid[0].checkoutId, orderA.checkoutId);
  assert.equal(paid[0].invoiceId, orderA.active.invoiceId);
});

test("createCheckout is a no-op for paid orders", async () => {
  const { wallet, openreceive, setNow } = await createHarness();
  const created = await openreceive.getOrCreateCheckout({
    orderId: "order-paid-noop",
    amount: { currency: "BTC", value: "0.000002" },
  });
  wallet.settlePaymentHash(created.active.paymentHash, 1200);
  setNow(1002);
  await openreceive.getOrder({ orderId: "order-paid-noop" });

  const before = wallet.makeInvoiceCalls;
  const paid = await openreceive.getOrCreateCheckout({
    orderId: "order-paid-noop",
    amount: { currency: "BTC", value: "0.000003" },
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
    message: "No order found for the given order_id.",
  });
});

test("service errors surface as OpenReceiveServiceError with status and body", async () => {
  const { wallet, openreceive } = await createHarness();

  await assertServiceError(
    () =>
      openreceive.getOrCreateCheckout({
        orderId: "order-invalid-fiat",
        amount: {
          currency: "usd",
          value: "0.10",
        },
      }),
    {
      status: 400,
      code: "INVALID_REQUEST",
      message: "amount.currency must be an ISO 4217 uppercase code, or BTC/SAT/SATS.",
    },
  );
  assert.equal(wallet.makeInvoiceCalls, 0);
});

test("getOrCreateCheckout accepts amount.currency and amount.sats shapes", async () => {
  const { wallet, openreceive } = await createHarness();

  const usd = await openreceive.getOrCreateCheckout({
    orderId: "order-amount-usd",
    amount: { currency: "USD", value: "0.10" },
  });
  const sats = await openreceive.getOrCreateCheckout({
    orderId: "order-amount-sats",
    amount: { sats: 200 },
  });

  assert.equal(usd.amountMsats, 200000);
  assert.deepEqual(usd.fiat, { currency: "USD", value: "0.10" });
  assert.equal(sats.amountMsats, 200000);
  assert.deepEqual(sats.invoices[0].fiatQuote, null);
  assert.equal(wallet.makeInvoiceCalls, 2);
});

test("getOrCreateCheckout rejects invalid explicit amount shapes", async () => {
  const { wallet, openreceive } = await createHarness();

  for (const amount of [{ msats: "200000" }, { currency: "USD" }, { value: "1.00" }]) {
    await assertServiceError(
      () =>
        openreceive.getOrCreateCheckout({
          orderId: `order-invalid-${Object.keys(amount).join("-")}`,
          amount,
        }),
      {
        status: 400,
        code: "INVALID_REQUEST",
        message: "Create checkout amount must be { sats } or { currency, value }.",
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
      openreceive.getOrCreateCheckout({
        orderId: "order-diagnostics",
        amount: { currency: "BTC", value: "0.000002" },
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

  const btcCheckout = await openreceive.getOrCreateCheckout({
    orderId: "order-live-btc",
    amount: { sats: "200" },
  });
  assert.equal(btcCheckout.amountMsats, 200000);
  assert.equal(fetchCalls, 0);

  await assertServiceError(
    () =>
      openreceive.getOrCreateCheckout({
        orderId: "order-live-fiat",
        amount: { currency: "USD", value: "0.10" },
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
      openreceive.getOrCreateCheckout({
        orderId: "order-live-fiat-retry",
        amount: { currency: "USD", value: "0.10" },
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

function xmlResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test("provider poll does not demote refund_pending back to refund_required", async () => {
  const swapProvider = new FakeSwapProvider(["USDT_TRON"]);
  const { openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-monotonic-refund",
    amount: { sats: "200" },
  });
  const attempt = await openreceive.startSwap({
    orderId: "order-swap-monotonic-refund",
    payInAsset: "USDT_TRON",
  });

  swapProvider.nextState = "refund_required";
  setNow(1015);
  const before = await openreceive.getOrder({ orderId: "order-swap-monotonic-refund" });
  const refundRequired = before.activeCheckout.invoices.find((invoice) => invoice.rail === "swap");
  assert.equal(refundRequired.swap.providerState, "refund_required");

  await openreceive.refundSwap({
    attemptId: attempt.attemptId,
    refundAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    refundNonce: refundRequired.swap.refundNonce,
  });
  await openreceive.refundSwap({
    attemptId: attempt.attemptId,
    refundAddress: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    refundNonce: refundRequired.swap.refundNonce,
    confirm: true,
  });

  // Provider still reports EMERGENCY/NONE (maps to refund_required) — must not demote.
  swapProvider.nextState = "refund_required";
  setNow(1030);
  const after = await openreceive.getOrder({ orderId: "order-swap-monotonic-refund" });
  const pending = after.activeCheckout.invoices.find((invoice) => invoice.rail === "swap");
  assert.equal(pending.swap.providerState, "refund_pending");
  assert.equal(pending.swap.refundNonce, undefined);
});

test("create timeout marks needs_reconcile and blocks another start for the asset", async () => {
  const swapProvider = new FakeSwapProvider(["USDT_TRON"]);
  swapProvider.createSwap = async () => {
    const error = new Error("FixedFloat create request timed out.");
    error.name = "FixedFloatApiError";
    error.kind = "timeout";
    throw error;
  };
  const { openreceive } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-create-timeout",
    amount: { sats: "200" },
  });

  await assert.rejects(
    () =>
      openreceive.startSwap({
        orderId: "order-swap-create-timeout",
        payInAsset: "USDT_TRON",
      }),
    (error) =>
      error instanceof OpenReceiveServiceError &&
      error.status === 409 &&
      /timed out|reconcile/i.test(error.message),
  );

  await assert.rejects(
    () =>
      openreceive.startSwap({
        orderId: "order-swap-create-timeout",
        payInAsset: "USDT_TRON",
      }),
    (error) =>
      error instanceof OpenReceiveServiceError &&
      error.status === 409 &&
      /reconcile/i.test(error.message),
  );
});

test("refreshSwap pulls provider state for provider_reported_emergency attention", async () => {
  const swapProvider = new FakeSwapProvider(["USDT_TRON"]);
  const { openreceive, setNow } = await createHarness({
    swap: { providers: [swapProvider] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-refresh",
    amount: { sats: "200" },
  });
  const attempt = await openreceive.startSwap({
    orderId: "order-swap-refresh",
    payInAsset: "USDT_TRON",
  });

  swapProvider.nextState = "attention";
  // Fake getStatus does not set attention_reason; force via a custom getStatus once.
  const originalGetStatus = swapProvider.getStatus.bind(swapProvider);
  swapProvider.getStatus = async (order) => {
    const updated = await originalGetStatus(order);
    if (updated.state === "attention") {
      return {
        ...updated,
        attention: true,
        attention_reason: "provider_reported_emergency",
      };
    }
    return updated;
  };

  setNow(1015);
  await openreceive.getOrder({ orderId: "order-swap-refresh" });

  swapProvider.nextState = "refunded";
  setNow(1030);
  const refreshed = await openreceive.refreshSwap({ attemptId: attempt.attemptId });
  assert.equal(refreshed.providerState, "refunded");
});

test("FixedFloat weight budget refuses creates once the soft create gate is hit", async () => {
  const {
    SwapProviderWeightBudget,
    SWAP_PROVIDER_CREATE_WEIGHT_GATE,
    SWAP_PROVIDER_CREATE_WEIGHT,
  } = await import("../../packages/js/node/src/swap/weight-budget.ts");
  const store = new InMemoryInvoiceKvStore();
  let now = 1_000;
  const denials = [];
  const budget = new SwapProviderWeightBudget(store, "fixedfloat", () => now, (denial) => {
    denials.push(denial);
  });

  // Fill up to the create gate with create reservations.
  let reserved = 0;
  while (reserved + SWAP_PROVIDER_CREATE_WEIGHT <= SWAP_PROVIDER_CREATE_WEIGHT_GATE) {
    await budget.reserve("create");
    reserved += SWAP_PROVIDER_CREATE_WEIGHT;
  }
  await assert.rejects(() => budget.reserve("create"), /weight budget/);
  assert.equal(denials.length, 1);
  assert.equal(denials[0]?.reason, "exhausted");
  assert.equal(denials[0]?.path, "create");
  assert.equal(denials[0]?.provider, "fixedfloat");
  // Status calls still have headroom under the overall soft cap.
  await budget.reserve("order");
});

test("swap provider API logs summarize FixedFloat envelopes without dumping bolt11", async () => {
  const {
    summarizeSwapProviderApiRequest,
    summarizeSwapProviderApiResponse,
  } = await import("../../packages/js/node/src/service/logging.ts");

  assert.deepEqual(
    summarizeSwapProviderApiRequest({
      provider: "fixedfloat",
      path: "order",
      body: { id: "P7XPEE", token: "secret-token" },
    }),
    { provider: "fixedfloat", path: "order", order_id: "P7XPEE" },
  );

  const summarized = summarizeSwapProviderApiResponse({
    provider: "fixedfloat",
    path: "order",
    status: 200,
    ok: true,
    code: 0,
    msg: "OK",
    data: {
      id: "P7XPEE",
      status: "NEW",
      time: { left: 348 },
      from: {
        code: "USDCSOL",
        amount: "12.24550000",
        address: "DNAW8HbXc9kjgVpg69usiAJLfMK1ZVGFusTCEHmGzcNL",
      },
      to: {
        code: "BTCLN",
        amount: "0.00018711",
        address: "lnbc187110n1p49y04cpp5kcvasyqqrgxsvejm4rv98t90hwufhvmvek764xgvhhuly2wq5raq",
      },
      emergency: { status: [], choice: "NONE", repeat: "0" },
      token: "secret-token",
    },
  });
  assert.deepEqual(summarized, {
    provider: "fixedfloat",
    path: "order",
    status: 200,
    ok: true,
    code: 0,
    order_id: "P7XPEE",
    order_status: "NEW",
    from: "USDCSOL 12.24550000",
    to: "BTCLN 0.00018711",
    left: 348,
  });
  assert.equal(JSON.stringify(summarized).includes("lnbc"), false);
  assert.equal(JSON.stringify(summarized).includes("secret-token"), false);
});

test("startSwap fails over to the next provider when the first is rate-limited", async () => {
  const primary = new FakeSwapProvider(["USDT_TRON"], "primary");
  const secondary = new FakeSwapProvider(["USDT_TRON"], "secondary");
  primary.canAcceptRequest = async () => false;
  const { openreceive } = await createHarness({
    swap: { providers: [primary, secondary] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-failover",
    amount: { sats: "200" },
  });

  const attempt = await openreceive.startSwap({
    orderId: "order-swap-failover",
    payInAsset: "USDT_TRON",
  });

  assert.equal(attempt.provider, "secondary");
  assert.equal(primary.createCalls, 0);
  assert.equal(secondary.createCalls, 1);
});

test("startSwap and swapQuote fail over when the first provider rates feed is down", async () => {
  const primary = new FakeSwapProvider(["USDT_TRON"], "primary");
  const secondary = new FakeSwapProvider(["USDT_TRON"], "secondary");
  primary.quote = async () => {
    throw new Error("FixedFloat rates fixed.xml request failed before a response was received.");
  };
  primary.payInAssetCatalog = async () => {
    throw new Error("FixedFloat rates fixed.xml request failed before a response was received.");
  };
  const { openreceive } = await createHarness({
    swap: { providers: [primary, secondary] },
  });
  await openreceive.getOrCreateCheckout({
    orderId: "order-swap-rates-failover",
    amount: { sats: "200" },
  });

  const options = await openreceive.swapOptions({ orderId: "order-swap-rates-failover" });
  const usdt = options.options.find((option) => option.payInAsset === "USDT_TRON");
  assert.equal(usdt?.provider, "secondary");
  assert.equal(usdt?.available, true);

  const quote = await openreceive.swapQuote({
    orderId: "order-swap-rates-failover",
    payInAsset: "USDT_TRON",
  });
  assert.equal(quote.provider, "secondary");
  assert.equal(quote.available, true);
  assert.equal(quote.payAmount, "1.05");

  const attempt = await openreceive.startSwap({
    orderId: "order-swap-rates-failover",
    payInAsset: "USDT_TRON",
  });
  assert.equal(attempt.provider, "secondary");
  assert.equal(primary.createCalls, 0);
  assert.equal(secondary.createCalls, 1);
});

test("selectSwapProvider prefers the first provider that still has create budget", async () => {
  const { selectSwapProvider } = await import("../../packages/js/node/src/service/swaps.ts");
  const primary = new FakeSwapProvider(["USDT_TRON"], "primary");
  const secondary = new FakeSwapProvider(["USDT_TRON"], "secondary");
  primary.canAcceptRequest = async (path) => path !== "create";
  secondary.canAcceptRequest = async () => true;

  const chosen = await selectSwapProvider([primary, secondary], "USDT_TRON", "create");
  assert.equal(chosen?.name, "secondary");

  const forPrice = await selectSwapProvider([primary, secondary], "USDT_TRON", "price");
  assert.equal(forPrice?.name, "primary");
});

test("FixedFloat /ccies omits currencies with recv=false", async () => {
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async (url) => {
      assert.match(String(url), /\/api\/v2\/ccies$/);
      return jsonResponse({
        code: 0,
        data: [
          {
            code: "USDTTRC",
            coin: "USDT",
            network: "TRX",
            recv: false,
            send: true,
          },
          {
            code: "BTCLN",
            coin: "BTC",
            network: "Lightning",
            recv: true,
            send: true,
          },
        ],
      });
    },
  });

  const assets = await provider.supportedPayInAssets();
  assert.equal(assets.has("USDT_TRON"), false);
});

test("FixedFloat status surfaces emergency.repeat", async () => {
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async () =>
      jsonResponse({
        code: 0,
        data: {
          id: "ff-order-repeat",
          token: "ff-token-repeat",
          status: "EMERGENCY",
          emergency: {
            status: ["LESS"],
            choice: "NONE",
            repeat: true,
          },
          from: {
            address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
            amount: "1.05",
          },
          time: { expiration: 4600 },
        },
      }),
  });

  const order = await provider.getStatus({
    provider: "fixedfloat",
    provider_order_id: "ff-order-repeat",
    provider_token: "ff-token-repeat",
    pay_in_asset: "USDT_TRON",
    deposit_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    deposit_amount: "1.05",
    expires_at: 4600,
    state: "awaiting_deposit",
  });

  assert.equal(order.state, "refund_required");
  assert.equal(order.emergency_repeat, true);
});

test("FixedFloat status maps emergency LESS to underpaid refund details", async () => {
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async () =>
      jsonResponse({
        code: 0,
        data: {
          id: "ff-order-less",
          token: "ff-token-less",
          status: "EMERGENCY",
          emergency: {
            status: ["LESS"],
            choice: "NONE",
          },
          from: {
            address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
            amount: "1.05",
            tx: {
              id: "txid-underpay",
              amount: "0.80",
            },
          },
          back: {
            amount: "0.79",
          },
          time: { expiration: 4600 },
        },
      }),
  });

  const order = await provider.getStatus({
    provider: "fixedfloat",
    provider_order_id: "ff-order-less",
    provider_token: "ff-token-less",
    pay_in_asset: "USDT_TRON",
    deposit_address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
    deposit_amount: "1.05",
    expires_at: 4600,
    state: "awaiting_deposit",
  });

  assert.equal(order.state, "refund_required");
  assert.equal(order.refund_reason, "underpaid");
  assert.equal(order.deposit_received_amount, "0.80");
  assert.equal(order.refund_amount, "0.79");
  assert.equal(order.deposit_tx_id, "txid-underpay");
});

test("FixedFloat status maps emergency EXPIRED+LESS to underpaid_and_late", async () => {
  const provider = fixedFloatProvider({
    key: "fixed-float-key",
    secret: "fixed-float-secret",
    baseUrl: "https://fixedfloat.example",
    fetch: async () =>
      jsonResponse({
        code: 0,
        data: {
          id: "ff-order-late",
          token: "ff-token-late",
          status: "EMERGENCY",
          emergency: {
            status: ["EXPIRED", "LESS"],
            choice: "NONE",
          },
          from: {
            address: "0x1111111111111111111111111111111111111111",
            amount: "0.0008",
            tx: { id: "0xlate", amount: "0.0005" },
          },
          time: { expiration: 1600 },
        },
      }),
  });

  const order = await provider.getStatus({
    provider: "fixedfloat",
    provider_order_id: "ff-order-late",
    provider_token: "ff-token-late",
    pay_in_asset: "ETH_ETH",
    deposit_address: "0x1111111111111111111111111111111111111111",
    deposit_amount: "0.0008",
    expires_at: 1600,
    state: "awaiting_deposit",
  });

  assert.equal(order.state, "refund_required");
  assert.equal(order.refund_reason, "underpaid_and_late");
  assert.equal(order.deposit_received_amount, "0.0005");
});

test("swapProviderIdFromBaseUrl derives stable ids from hostnames", async () => {
  const { swapProviderIdFromBaseUrl } = await import("../../packages/js/node/src/config.ts");
  assert.equal(swapProviderIdFromBaseUrl("https://ff.io"), "ff-io");
  assert.equal(swapProviderIdFromBaseUrl("https://ff.io/"), "ff-io");
  assert.equal(swapProviderIdFromBaseUrl("https://FixedFloat.example"), "fixedfloat-example");
  assert.equal(swapProviderIdFromBaseUrl("https://ff.io:8443"), "ff-io-8443");
  assert.throws(() => swapProviderIdFromBaseUrl("not-a-url"), /valid absolute URL/);
});

test("readOpenReceiveConfigFile parses optional sentry fields", async () => {
  const { readOpenReceiveConfigFile } = await import("../../packages/js/node/src/config.ts");
  const dir = mkdtempSync(path.join(tmpdir(), "openreceive-sentry-config-"));
  try {
    writeFileSync(
      path.join(dir, "openreceive.yml"),
      [
        "sentry:",
        '  dsn: "https://public@o0.ingest.sentry.io/1"',
        "  environment: staging",
        "  release: openreceive@0.1.1",
        "",
      ].join("\n"),
    );

    assert.deepEqual(readOpenReceiveConfigFile({ cwd: dir }), {
      sentry: {
        dsn: "https://public@o0.ingest.sentry.io/1",
        environment: "staging",
        release: "openreceive@0.1.1",
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

